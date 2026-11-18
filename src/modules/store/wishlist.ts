import { Router, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { products, wishlistItems } from '../../db/schema/index.ts';
import { conflict, notFound, unauthorized } from '../../lib/errors.ts';
import { currentCustomer, CUSTOMER_COOKIE } from './account/session.ts';
import { cards } from './catalog.ts';

/**
 * The wishlist (the heart): a signed-in customer's saved products. Saved with the price and stock at
 * that moment, so the shop can say "cheaper since you saved it" and "back in stock".
 */
export const wishlistRouter = Router();

const MOST = 200;

async function signedIn(req: Request) {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in');
  return c;
}

const idList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** Product cards for these ids, in this order (for the website's wishlist page and fragments). */
export async function cardsByIds(ids: number[]) {
  if (!ids.length) return [];
  const { items } = await cards(sql`c.id in (${idList(ids)})`, sql`array_position(array[${idList(ids)}]::bigint[], c.id)`, ids.length);
  // cards() puts what can be bought first: put them back in the asked order.
  const at = new Map(ids.map((id, i) => [id, i]));
  return items.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
}

const idsQuery = z.object({
  ids: z
    .string()
    .max(1000)
    .catch('')
    .transform((v) => [...new Set(v.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 60)),
});

/** Product cards by id (public: the same as any product list). Products no longer for sale are left out. */
wishlistRouter.get('/cards', async (req, res) => {
  const { ids } = idsQuery.parse(req.query);
  res.set('cache-control', 'public, max-age=60, stale-while-revalidate=300').json({ items: await cardsByIds(ids) });
});

/** Which products they saved (for the hearts on every page). */
wishlistRouter.get('/me/wishlist/ids', async (req, res) => {
  res.set('cache-control', 'no-store');
  const c = await currentCustomer(req);
  if (!c) {
    res.json({ ids: [] });
    return;
  }
  const rows = await db.select({ id: wishlistItems.productId }).from(wishlistItems).where(eq(wishlistItems.customerId, c.id)).orderBy(desc(wishlistItems.createdAt));
  res.json({ ids: rows.map((r) => r.id) });
});

/** Their saved products, newest first, with what changed since: cheaper now, back in stock. */
wishlistRouter.get('/me/wishlist', async (req, res) => {
  const c = await signedIn(req);
  const rows = await db.select().from(wishlistItems).where(eq(wishlistItems.customerId, c.id)).orderBy(desc(wishlistItems.createdAt)).limit(MOST);
  const now = new Map((await cardsByIds(rows.map((r) => r.productId).slice(0, MOST))).map((p) => [p.id, p]));
  res.set('cache-control', 'no-store').json({
    items: rows
      .filter((r) => now.has(r.productId))
      .map((r) => {
        const p = now.get(r.productId)!;
        const cheaper = r.priceWhenSaved !== null && p.price < r.priceWhenSaved ? Math.round((r.priceWhenSaved - p.price) * 100) / 100 : null;
        return { productId: r.productId, slug: p.slug, savedAt: r.createdAt, priceWhenSaved: r.priceWhenSaved, price: p.price, inStock: p.inStock, cheaper, backInStock: !r.inStockWhenSaved && p.inStock };
      }),
  });
});

// Plenty for people tapping hearts, not for scripts. Counted per signed-in shopper.
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.cookies?.[CUSTOMER_COOKIE] as string | undefined) ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'TOO_MANY', message: 'Too many changes. Please wait a while and try again.' } },
});

const productId = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Product not found');
  return id;
};

/** Save a product (saving it again changes nothing). */
wishlistRouter.put('/me/wishlist/:productId', writeLimiter, async (req, res) => {
  const c = await signedIn(req);
  const id = productId(req.params.productId);
  const [p] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, id), eq(products.status, 'active')));
  if (!p) throw notFound('Product not found');
  const [{ n }] = (await db.select({ n: count() }).from(wishlistItems).where(eq(wishlistItems.customerId, c.id))) as [{ n: number }];
  const [card] = await cardsByIds([id]);
  if (n >= MOST) {
    const [already] = await db.select({ id: wishlistItems.productId }).from(wishlistItems).where(and(eq(wishlistItems.customerId, c.id), eq(wishlistItems.productId, id)));
    if (!already) throw conflict(`Your wishlist is full (${MOST} products). Remove some first.`);
  }
  await db
    .insert(wishlistItems)
    .values({ customerId: c.id, productId: id, priceWhenSaved: card?.price ?? null, inStockWhenSaved: card?.inStock ?? true })
    .onConflictDoNothing();
  res.status(204).end();
});

/** Remove a product from the wishlist. */
wishlistRouter.delete('/me/wishlist/:productId', writeLimiter, async (req, res) => {
  const c = await signedIn(req);
  await db.delete(wishlistItems).where(and(eq(wishlistItems.customerId, c.id), eq(wishlistItems.productId, productId(req.params.productId))));
  res.status(204).end();
});
