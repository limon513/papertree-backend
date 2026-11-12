import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { categories, coupons, orders, productCategories, products } from '../../../db/schema/index.ts';
import { couponAmount, type CouponLine, type CouponResult, type CouponRule } from '../../../lib/coupon.ts';
import { AppError } from '../../../lib/errors.ts';
import type { Tx } from '../products/service.ts';

export type CouponRow = typeof coupons.$inferSelect;

/**
 * Who may use a coupon, and when. The maths is in lib/coupon.ts.
 * Every refusal is a CouponError (409 COUPON) with a message the shopper can read.
 */
export type CouponProblemReason = 'unknown' | 'inactive' | 'not_started' | 'ended' | 'used_up' | 'wholesale' | 'used_by_you' | 'new_only' | 'no_items' | 'min_order';

export class CouponError extends AppError {
  readonly reason: CouponProblemReason;
  constructor(reason: CouponProblemReason, message: string) {
    super(409, 'COUPON', message, { couponCode: message });
    this.reason = reason;
  }
}

/** "SCHOOL 10 " -> "SCHOOL10". */
export const cleanCode = (code: string) => code.replace(/\s+/g, '').toUpperCase();

const bdDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The coupon with this code. `lock`: hold its row until the order is saved (use limits stay exact). */
export async function findCoupon(tx: Tx | typeof db, code: string, lock = false) {
  const q = tx.select().from(coupons).where(eq(coupons.code, cleanCode(code))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

export interface Who {
  /** The order's phone number (null: not known yet, in the cart). */
  phone: string | null;
  /** A signed-in shopper, or the customer of an order being edited. */
  customerId: number | null;
  /** When editing an order: that order does not count as an earlier use. */
  orderId?: number | null;
}

/**
 * Can this coupon be used now, by this person? Throws a CouponError if not. Without a phone (the cart,
 * before checkout) the per-person rules are left for the order; `phoneChecked` says whether they ran.
 */
export async function checkCouponUse(tx: Tx | typeof db, c: CouponRow | null, who: Who, now = new Date()) {
  // A private coupon for someone else looks just like an unknown code (nothing is revealed).
  if (!c || (c.phone && who.phone && c.phone !== who.phone)) throw new CouponError('unknown', "We don't know this code. Check the spelling.");
  if (!c.isActive) throw new CouponError('inactive', 'This code is no longer active.');
  if (c.startsAt && c.startsAt > now) throw new CouponError('not_started', `This code works from ${bdDate(c.startsAt)}.`);
  if (c.endsAt && c.endsAt <= now) throw new CouponError('ended', `This code ended on ${bdDate(c.endsAt)}.`);
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) throw new CouponError('used_up', 'This code has been fully used.');

  const personal = !!c.phone || c.newCustomersOnly || c.perCustomerLimit !== null;
  if (!who.phone && !who.customerId) return { phoneChecked: !personal };
  if (c.phone && !who.phone) return { phoneChecked: false };

  // The same person: this phone number, or this account.
  const mine = (extra: SQL) => {
    const person = [who.phone ? eq(orders.phone, who.phone) : undefined, who.customerId ? eq(orders.customerId, who.customerId) : undefined].filter((x): x is SQL => !!x);
    return and(or(...person), extra, who.orderId ? ne(orders.id, who.orderId) : undefined);
  };
  if (c.newCustomersOnly) {
    const [earlier] = await tx.select({ id: orders.id }).from(orders).where(mine(sql`true`)).limit(1);
    if (earlier) throw new CouponError('new_only', 'This code is for first orders only.');
  }
  if (c.perCustomerLimit !== null) {
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(mine(eq(orders.couponId, c.id)));
    if (n >= c.perCustomerLimit) {
      throw new CouponError('used_by_you', c.perCustomerLimit === 1 ? 'You have already used this code.' : `You have already used this code ${n} times (the most allowed).`);
    }
  }
  return { phoneChecked: !!who.phone || !c.phone };
}

export const ruleOf = (c: CouponRow): CouponRule => ({
  type: c.type,
  value: c.value,
  maxDiscount: c.maxDiscount,
  minOrder: c.minOrder,
  onSaleItems: c.onSaleItems,
  withBulk: c.withBulk,
  productIds: c.items.productIds ?? [],
  categoryIds: c.items.categoryIds ?? [],
  brandIds: c.items.brandIds ?? [],
});

/** A category list with all their sub-categories. */
async function withSubcategories(tx: Tx | typeof db, ids: number[]) {
  if (!ids.length) return [];
  const all = await tx.select({ id: categories.id, parentId: categories.parentId }).from(categories);
  const found = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parentId !== null && found.has(c.parentId) && !found.has(c.id)) {
        found.add(c.id);
        grew = true;
      }
    }
  }
  return [...found];
}

/** Brand and categories of each line's product, for coupons that are only for some items. */
export async function couponLinesFor(
  tx: Tx | typeof db,
  rule: CouponRule,
  lines: { productId: number; lineTotal: number; onSale: boolean; bulkPercent: number | null }[],
): Promise<{ rule: CouponRule; lines: CouponLine[] }> {
  const filtered = rule.productIds.length || rule.categoryIds.length || rule.brandIds.length;
  if (!filtered || !lines.length) return { rule, lines: lines.map((l) => ({ ...l, brandId: null, categoryIds: [] })) };
  const ids = [...new Set(lines.map((l) => l.productId))];
  const [brands, cats, categoryIds] = await Promise.all([
    tx.select({ id: products.id, brandId: products.brandId }).from(products).where(inArray(products.id, ids)),
    tx.select({ productId: productCategories.productId, categoryId: productCategories.categoryId }).from(productCategories).where(inArray(productCategories.productId, ids)),
    withSubcategories(tx, rule.categoryIds),
  ]);
  const brandOf = new Map(brands.map((b) => [b.id, b.brandId]));
  return {
    rule: { ...rule, categoryIds },
    lines: lines.map((l) => ({ ...l, brandId: brandOf.get(l.productId) ?? null, categoryIds: cats.filter((c) => c.productId === l.productId).map((c) => c.categoryId) })),
  };
}

/** The coupon's amount for these lines, or a CouponError saying why it gives nothing. */
export async function couponFor(
  tx: Tx | typeof db,
  c: CouponRow,
  lines: { productId: number; lineTotal: number; onSale: boolean; bulkPercent: number | null }[],
  deliveryFee: number | null,
): Promise<CouponResult> {
  const prepared = await couponLinesFor(tx, ruleOf(c), lines);
  return couponAmount(prepared.rule, prepared.lines, deliveryFee);
}

/** "10% off (up to ৳200)", "৳100 off", "Free delivery". */
export function couponLabel(c: CouponRow) {
  if (c.type === 'percent') return `${c.value}% off${c.maxDiscount !== null ? ` (up to ${taka(c.maxDiscount)})` : ''}`;
  if (c.type === 'fixed') return `${taka(c.value ?? 0)} off`;
  return 'Free delivery';
}

/** The shopper-facing reason a coupon gives nothing on this cart. */
export function shortfallMessage(result: CouponResult) {
  if (result.reason === 'min_order') return `Add ${taka(result.short ?? 0)} more to use this code.`;
  return 'This code does not apply to the items in your cart.';
}

// ---- Guessing codes ----

/**
 * Wrong codes per connection: 50 per 10 minutes, then codes are not even looked up for a while. Enough
 * to make automated guessing useless, while many shoppers sharing one mobile network address are not
 * blocked by one person's typos. (Valuable coupons are protected by their own limits: per customer,
 * total uses, first orders, private phone.) Kept in memory, per server process.
 */
const WRONG_LIMIT = 50;
const WINDOW = 10 * 60_000;
const wrong = new Map<string, { count: number; until: number }>();

export const codeGuard = {
  allowed(ip: string | undefined) {
    const w = wrong.get(ip ?? '?');
    if (!w || w.until < Date.now()) return true;
    return w.count < WRONG_LIMIT;
  },
  failed(ip: string | undefined) {
    const key = ip ?? '?';
    const w = wrong.get(key);
    if (!w || w.until < Date.now()) wrong.set(key, { count: 1, until: Date.now() + WINDOW });
    else w.count++;
    // Keep the map small.
    if (wrong.size > 10_000) for (const [k, v] of wrong) if (v.until < Date.now()) wrong.delete(k);
  },
};
export const tooManyTries = () => new AppError(429, 'TOO_MANY_REQUESTS', 'Too many wrong codes. Please wait a few minutes and try again.');
