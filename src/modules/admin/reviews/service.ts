import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { media, productReviews, products } from '../../../db/schema/index.ts';
import { publicImage } from '../../store/catalog.ts';

/**
 * Reviews: one per customer per product, from customers who received it, shown after staff approve.
 * The product keeps the count and average of its approved reviews.
 */

/** Recounts a product's approved reviews (call after any approve, reject, edit or delete). */
export async function refreshRating(productId: number) {
  await db.execute(sql`
    update products p set
      rating_count = r.n,
      rating_average = case when r.n > 0 then round(r.avg, 2) else null end
    from (select count(*)::int as n, avg(rating)::numeric as avg from product_reviews where product_id = ${productId} and status = 'approved') r
    where p.id = ${productId}`);
}

/** "Nusrat Jahan" → "Nusrat J." (what other shoppers see). */
export function shortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  return parts.length === 1 ? parts[0]!.slice(0, 30) : `${parts[0]!.slice(0, 30)} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/** Review photos as the website shows them, in their order. */
export async function photosOf(ids: number[]) {
  if (!ids.length) return new Map<number, ReturnType<typeof publicImage>>();
  const rows = await db.select().from(media).where(inArray(media.id, ids));
  return new Map(rows.map((m) => [m.id, publicImage(m)]));
}

/** Their delivered order with this product (the proof they bought it), or null. */
export async function deliveredOrderWith(customerId: number, productId: number) {
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from orders o join order_items oi on oi.order_id = o.id
    where o.customer_id = ${customerId} and o.status = 'delivered' and oi.product_id = ${productId}
    order by o.delivered_at desc nulls last limit 1`);
  return rows[0] ? Number(rows[0].id) : null;
}

/** Text as typed, tidied: no control characters, at most `max` letters. */
export const cleanText = (v: string | null | undefined, max: number) => {
  const t = (v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t ? t.slice(0, max) : null;
};

export const reviewOf = (id: number) => db.select().from(productReviews).where(eq(productReviews.id, id));
export const productOf = (id: number) => db.select({ id: products.id, name: products.name, slug: products.slug }).from(products).where(and(eq(products.id, id)));
