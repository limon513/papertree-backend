import { Router } from 'express';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { brands, categories, coupons, orders, products } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { couponBody, couponListQuery, type CouponInput } from './schemas.ts';
import { couponLabel, type CouponRow } from './service.ts';

/** Coupon codes. Mounted behind requireAdmin + requireModule('marketing'). */
export const couponsRouter = Router();

/** Live now, waiting to start, ended (by date or fully used), or switched off. */
export function couponState(c: CouponRow, now = new Date()) {
  if (!c.isActive) return 'off' as const;
  if (c.startsAt && c.startsAt > now) return 'scheduled' as const;
  if ((c.endsAt && c.endsAt <= now) || (c.usageLimit !== null && c.usedCount >= c.usageLimit)) return 'ended' as const;
  return 'live' as const;
}

/** Orders with each coupon, and the taka it gave (cancelled and returned orders gave nothing). */
async function statsFor(ids: number[]) {
  if (!ids.length) return new Map<number, { orders: number; given: number; sales: number }>();
  const rows = await db
    .select({
      couponId: orders.couponId,
      orders: sql<number>`count(*)::int`,
      given: sql<number>`coalesce(sum(${orders.couponDiscount}) filter (where ${orders.status} not in ('cancelled', 'returned')), 0)`.mapWith(Number),
      sales: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'returned')), 0)`.mapWith(Number),
    })
    .from(orders)
    .where(inArray(orders.couponId, ids))
    .groupBy(orders.couponId);
  return new Map(rows.map((r) => [r.couponId!, { orders: r.orders, given: r.given, sales: r.sales }]));
}

function view(c: CouponRow, stats?: { orders: number; given: number; sales: number }) {
  return {
    ...c,
    label: couponLabel(c),
    state: couponState(c),
    /** Orders placed with it (= uses, cancelled ones included), the taka it gave and the sales it brought. */
    stats: stats ?? { orders: 0, given: 0, sales: 0 },
  };
}

/** The products, categories and brands it is limited to must exist. */
async function checkItems(input: CouponInput) {
  const { productIds, categoryIds, brandIds } = input.items;
  const [p, c, b] = await Promise.all([
    productIds.length ? db.select({ id: products.id }).from(products).where(inArray(products.id, productIds)) : [],
    categoryIds.length ? db.select({ id: categories.id }).from(categories).where(inArray(categories.id, categoryIds)) : [],
    brandIds.length ? db.select({ id: brands.id }).from(brands).where(inArray(brands.id, brandIds)) : [],
  ]);
  if (p.length !== new Set(productIds).size) throw badRequest('A chosen product no longer exists', { 'items.productIds': 'A chosen product no longer exists' });
  if (c.length !== new Set(categoryIds).size) throw badRequest('A chosen category no longer exists', { 'items.categoryIds': 'A chosen category no longer exists' });
  if (b.length !== new Set(brandIds).size) throw badRequest('A chosen brand no longer exists', { 'items.brandIds': 'A chosen brand no longer exists' });
}

const values = (input: CouponInput) => ({
  ...input,
  startsAt: input.startsAt ? new Date(input.startsAt) : null,
  endsAt: input.endsAt ? new Date(input.endsAt) : null,
  items: { productIds: [...new Set(input.items.productIds)], categoryIds: [...new Set(input.items.categoryIds)], brandIds: [...new Set(input.items.brandIds)] },
});

async function getCoupon(id: number) {
  const [row] = await db.select().from(coupons).where(eq(coupons.id, id));
  if (!row) throw notFound('Coupon not found');
  return row;
}

couponsRouter.get('/', async (req, res) => {
  const q = couponListQuery.parse(req.query);
  const where = q.search ? or(ilike(coupons.code, `%${q.search.replace(/[%_\\]/g, '')}%`), ilike(coupons.note, `%${q.search.replace(/[%_\\]/g, '')}%`)) : undefined;
  const rows = await db.select().from(coupons).where(where).orderBy(desc(coupons.createdAt)).limit(500);
  const stats = await statsFor(rows.map((r) => r.id));
  const all = rows.map((r) => view(r, stats.get(r.id)));
  res.json({ items: q.view === 'all' ? all : all.filter((c) => c.state === q.view) });
});

couponsRouter.get('/:id', async (req, res) => {
  const c = await getCoupon(parseId(req.params.id));
  const recent = await db
    .select({ id: orders.id, number: orders.number, customerName: orders.customerName, phone: orders.phone, status: orders.status, total: orders.total, couponDiscount: orders.couponDiscount, createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.couponId, c.id))
    .orderBy(desc(orders.createdAt))
    .limit(50);
  res.json({ ...view(c, (await statsFor([c.id])).get(c.id)), recentOrders: recent });
});

couponsRouter.post('/', async (req, res) => {
  const input = couponBody.parse(req.body);
  await checkItems(input);
  const [exists] = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, input.code));
  if (exists) throw conflict('There is already a coupon with this code', { code: 'Already used by another coupon' });
  const [row] = await db.insert(coupons).values({ ...values(input), createdBy: currentAdmin(req).id }).returning();
  await audit(req, { action: 'coupon.create', entityType: 'coupon', entityId: row!.id, after: values(input) });
  res.status(201).json(view(row!));
});

couponsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await getCoupon(id);
  const input = couponBody.parse(req.body);
  await checkItems(input);
  // Orders keep the code they were placed with: a used coupon keeps its code.
  if (before.usedCount > 0 && input.code !== before.code) throw badRequest('This coupon was used, so its code cannot change. Make a new coupon instead.', { code: 'Used: the code cannot change' });
  const [clash] = await db.select({ id: coupons.id }).from(coupons).where(and(eq(coupons.code, input.code), sql`${coupons.id} <> ${id}`));
  if (clash) throw conflict('There is already a coupon with this code', { code: 'Already used by another coupon' });
  const [row] = await db.update(coupons).set(values(input)).where(eq(coupons.id, id)).returning();
  const { createdAt: _c, updatedAt: _u, usedCount: _n, createdBy: _b, id: _i, ...was } = before;
  await audit(req, { action: 'coupon.update', entityType: 'coupon', entityId: id, before: was, after: values(input) });
  res.json(view(row!, (await statsFor([id])).get(id)));
});

/** Switch on or off. */
couponsRouter.post('/:id/active', async (req, res) => {
  const id = parseId(req.params.id);
  await getCoupon(id);
  const active = req.body?.active === true;
  const [row] = await db.update(coupons).set({ isActive: active }).where(eq(coupons.id, id)).returning();
  await audit(req, { action: active ? 'coupon.on' : 'coupon.off', entityType: 'coupon', entityId: id });
  res.json(view(row!, (await statsFor([id])).get(id)));
});

/** Only a coupon never used can be deleted (orders keep theirs): otherwise switch it off. */
couponsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const c = await getCoupon(id);
  const [used] = await db.select({ id: orders.id }).from(orders).where(eq(orders.couponId, id)).limit(1);
  if (c.usedCount > 0 || used) throw badRequest('This coupon was used, so it cannot be deleted. Switch it off instead.');
  await db.delete(coupons).where(eq(coupons.id, id));
  await audit(req, { action: 'coupon.delete', entityType: 'coupon', entityId: id, before: { code: c.code } });
  res.status(204).end();
});
