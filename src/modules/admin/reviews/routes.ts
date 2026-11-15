import { Router } from 'express';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { customers, orders, productReviews, products, REVIEW_STATUSES } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { imagesById } from '../../store/catalog.ts';
import { cleanText, photosOf, refreshRating, reviewOf } from './service.ts';

/** Reviews to approve, reject or answer. Mounted behind requireAdmin + requireModule('products'). */
export const reviewsAdminRouter = Router();

const PAGE = 20;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const reviewListQuery = z.object({
  status: z.enum(REVIEW_STATUSES).default('pending'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});

reviewsAdminRouter.get('/', async (req, res) => {
  const q = reviewListQuery.parse(req.query);
  const search = q.search
    ? or(ilike(products.name, `%${escapeLike(q.search)}%`), ilike(customers.name, `%${escapeLike(q.search)}%`), ilike(customers.phone, `%${escapeLike(q.search)}%`))
    : undefined;
  const where = and(eq(productReviews.status, q.status), search);
  const base = () =>
    db
      .select({
        review: productReviews,
        product: { id: products.id, name: products.name, slug: products.slug },
        imageId: sql<number | null>`(select pi.media_id from product_images pi where pi.product_id = ${products.id} order by pi.position limit 1)`.mapWith((v) => (v === null ? null : Number(v))),
        customer: { id: customers.id, name: customers.name, phone: customers.phone },
        orderNumber: orders.number,
      })
      .from(productReviews)
      .innerJoin(products, eq(products.id, productReviews.productId))
      .innerJoin(customers, eq(customers.id, productReviews.customerId))
      .leftJoin(orders, eq(orders.id, productReviews.orderId));
  const [rows, [total], counts] = await Promise.all([
    base().where(where).orderBy(desc(productReviews.updatedAt), desc(productReviews.id)).limit(PAGE).offset((q.page - 1) * PAGE),
    db.select({ n: count() }).from(productReviews).innerJoin(products, eq(products.id, productReviews.productId)).innerJoin(customers, eq(customers.id, productReviews.customerId)).where(where),
    db.select({ status: productReviews.status, n: count() }).from(productReviews).groupBy(productReviews.status),
  ]);
  const [photos, images] = await Promise.all([photosOf(rows.flatMap((r) => r.review.photoIds)), imagesById(rows.map((r) => r.imageId))]);
  res.json({
    items: rows.map((r) => ({
      id: r.review.id,
      rating: r.review.rating,
      body: r.review.body,
      photos: r.review.photoIds.map((id) => photos.get(id)).filter(Boolean),
      status: r.review.status,
      rejectReason: r.review.rejectReason,
      reply: r.review.reply,
      createdAt: r.review.createdAt,
      updatedAt: r.review.updatedAt,
      decidedAt: r.review.decidedAt,
      product: { ...r.product, image: r.imageId ? (images.get(r.imageId) ?? null) : null },
      customer: r.customer,
      orderNumber: r.orderNumber,
    })),
    total: total!.n,
    page: q.page,
    pageSize: PAGE,
    counts: Object.fromEntries(REVIEW_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])),
  });
});

async function decide(id: number, status: 'approved' | 'rejected', reason: string | null, adminId: number) {
  const [before] = await reviewOf(id);
  if (!before) throw notFound('Review not found');
  await db
    .update(productReviews)
    .set({ status, rejectReason: status === 'rejected' ? reason : null, decidedBy: adminId, decidedAt: new Date() })
    .where(eq(productReviews.id, id));
  await refreshRating(before.productId);
  return before;
}

reviewsAdminRouter.post('/:id/approve', async (req, res) => {
  const id = parseId(req.params.id);
  const before = await decide(id, 'approved', null, currentAdmin(req).id);
  await audit(req, { action: 'review.approve', entityType: 'review', entityId: id, before: { status: before.status } });
  res.json({ id, status: 'approved' });
});

export const rejectBody = z.object({ reason: z.string().max(500).nullable().default(null) }).meta({ id: 'ReviewRejectBody' });

reviewsAdminRouter.post('/:id/reject', async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = rejectBody.parse(req.body ?? {});
  const before = await decide(id, 'rejected', cleanText(reason, 500), currentAdmin(req).id);
  await audit(req, { action: 'review.reject', entityType: 'review', entityId: id, before: { status: before.status }, after: { reason } });
  res.json({ id, status: 'rejected' });
});

export const replyBody = z.object({ reply: z.string().max(4000).nullable() }).meta({ id: 'ReviewReplyBody' });

/** The shop's answer under the review (null removes it). */
reviewsAdminRouter.put('/:id/reply', async (req, res) => {
  const id = parseId(req.params.id);
  const [before] = await reviewOf(id);
  if (!before) throw notFound('Review not found');
  const reply = cleanText(req.body?.reply === undefined ? null : replyBody.parse(req.body).reply, 2000);
  await db.update(productReviews).set({ reply, repliedAt: reply ? new Date() : null }).where(eq(productReviews.id, id));
  await audit(req, { action: 'review.reply', entityType: 'review', entityId: id, after: { reply } });
  res.json({ id, reply });
});

reviewsAdminRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db.delete(productReviews).where(eq(productReviews.id, id)).returning();
  if (!row) throw notFound('Review not found');
  if (row.status === 'approved') await refreshRating(row.productId);
  await audit(req, { action: 'review.delete', entityType: 'review', entityId: id, before: row });
  res.status(204).end();
});
