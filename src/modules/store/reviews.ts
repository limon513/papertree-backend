import { Router, type Request } from 'express';
import multer from 'multer';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { and, count, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { customers, MAX_REVIEW_PHOTOS, media, productReviews, products } from '../../db/schema/index.ts';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.ts';
import { storeImage } from '../admin/media/store.ts';
import { cleanText, deliveredOrderWith, photosOf, refreshRating, shortName } from '../admin/reviews/service.ts';
import { actingStaff, currentCustomer, CUSTOMER_COOKIE } from './account/session.ts';
import { imagesById, publicImage } from './catalog.ts';

/**
 * Ratings and reviews on the website. Anyone reads approved reviews; customers who received a product
 * write one (with up to 2 photos), which staff approve before it shows.
 */
export const reviewsRouter = Router();

const PAGE = 10;
const cache = (seconds: number) => `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`;

async function signedIn(req: Request) {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in');
  return c;
}

/** Reviews are the customer's own words: never written by staff logged in as them. */
async function ownWords(req: Request) {
  if (await actingStaff(req)) throw forbidden('Staff cannot write reviews for a customer.');
}

// ---- Reading (everyone) ----

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(200).catch(1),
  stars: z.coerce.number().int().min(1).max(5).optional().catch(undefined),
});

/** A product's approved reviews, newest first, with the summary (average, count, per star). */
reviewsRouter.get('/products/:slug/reviews', async (req, res) => {
  const q = listQuery.parse(req.query);
  const [p] = await db
    .select({ id: products.id, ratingCount: products.ratingCount, ratingAverage: products.ratingAverage })
    .from(products)
    .where(and(eq(products.slug, String(req.params.slug)), eq(products.status, 'active')));
  if (!p) throw notFound('Product not found');
  const approved = and(eq(productReviews.productId, p.id), eq(productReviews.status, 'approved'), q.stars ? eq(productReviews.rating, q.stars) : undefined);
  const [rows, [total], perStar] = await Promise.all([
    db
      .select({ review: productReviews, name: customers.name })
      .from(productReviews)
      .innerJoin(customers, eq(customers.id, productReviews.customerId))
      .where(approved)
      .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
      .limit(PAGE)
      .offset((q.page - 1) * PAGE),
    db.select({ n: count() }).from(productReviews).where(approved),
    db
      .select({ rating: productReviews.rating, n: count() })
      .from(productReviews)
      .where(and(eq(productReviews.productId, p.id), eq(productReviews.status, 'approved')))
      .groupBy(productReviews.rating),
  ]);
  const photos = await photosOf(rows.flatMap((r) => r.review.photoIds));
  res.set('cache-control', cache(60)).json({
    summary: {
      average: p.ratingAverage,
      count: p.ratingCount,
      /** How many reviews gave 5, 4, 3, 2 and 1 stars. */
      stars: Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, perStar.find((x) => x.rating === s)?.n ?? 0])),
    },
    items: rows.map(({ review: r, name }) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      photos: r.photoIds.map((id) => photos.get(id)).filter(Boolean),
      name: shortName(name),
      /** Every review here is from someone who received the product. */
      verified: true,
      createdAt: r.createdAt,
      reply: r.reply,
      repliedAt: r.repliedAt,
    })),
    total: total!.n,
    page: q.page,
    pages: Math.max(1, Math.ceil(total!.n / PAGE)),
  });
});

// ---- The shopper's own ----

/** Can they review this product, and their review of it (any status). */
reviewsRouter.get('/me/reviews/:productId', async (req, res) => {
  res.set('cache-control', 'no-store');
  const c = await currentCustomer(req);
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw notFound('Product not found');
  if (!c) {
    res.json({ canReview: false, reason: 'sign_in', review: null });
    return;
  }
  const [[mine], orderId] = await Promise.all([
    db.select().from(productReviews).where(and(eq(productReviews.productId, productId), eq(productReviews.customerId, c.id))),
    deliveredOrderWith(c.id, productId),
  ]);
  const photos = await photosOf(mine?.photoIds ?? []);
  res.json({
    canReview: !!orderId,
    reason: orderId ? null : 'not_delivered',
    review: mine
      ? {
          id: mine.id,
          rating: mine.rating,
          body: mine.body,
          photos: mine.photoIds.map((id) => (photos.get(id) ? { id, ...photos.get(id)! } : null)).filter(Boolean),
          status: mine.status,
          reply: mine.reply,
          updatedAt: mine.updatedAt,
        }
      : null,
  });
});

/** Products from their delivered orders that they have not reviewed yet (for "Rate your purchases"). */
reviewsRouter.get('/me/reviewable', async (req, res) => {
  const c = await signedIn(req);
  const { rows } = await db.execute<{ id: string; slug: string; name: string; image_id: string | null; delivered_at: string | null }>(sql`
    select distinct on (p.id) p.id, p.slug, p.name,
      (select pi.media_id from product_images pi where pi.product_id = p.id order by pi.position limit 1) as image_id,
      o.delivered_at
    from orders o join order_items oi on oi.order_id = o.id join products p on p.id = oi.product_id
    where o.customer_id = ${c.id} and o.status = 'delivered' and p.status = 'active'
      and not exists (select 1 from product_reviews r where r.product_id = p.id and r.customer_id = ${c.id})
    order by p.id, o.delivered_at desc nulls last
    limit 50`);
  const images = await imagesById(rows.map((r) => (r.image_id ? Number(r.image_id) : null)));
  const items = rows
    .map((r) => ({ productId: Number(r.id), slug: r.slug, name: r.name, image: r.image_id ? (images.get(Number(r.image_id)) ?? null) : null, deliveredAt: r.delivered_at }))
    .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)))
    .slice(0, 20);
  res.set('cache-control', 'no-store').json({ items });
});

// A few reviews and photos an hour: plenty for people, not for spam.
// Counted per signed-in shopper (many people can share one mobile network's address).
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.cookies?.[CUSTOMER_COOKIE] as string | undefined) ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'TOO_MANY', message: 'Too many tries. Please wait a while and try again.' } },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    // Photos only: never SVG (it can carry scripts). Every photo is redrawn as WebP, which also drops the phone's location data.
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return done(null, true);
    done(badRequest('Use a JPG, PNG or WebP photo', { file: 'Use a JPG, PNG or WebP photo' }));
  },
});

/** A photo for a review (signed in). Answers its id, to send with the review. */
reviewsRouter.post('/me/review-photos', writeLimiter, upload.single('file'), async (req, res) => {
  const c = await signedIn(req);
  await ownWords(req);
  if (!req.file) throw badRequest('Choose a photo', { file: 'Choose a photo' });
  const row = await storeImage(req.file.buffer, 'review-photo.jpg', null, c.id);
  res.status(201).json({ id: row.id, ...publicImage(row) });
});

export const reviewBody = z
  .object({
    productId: z.number().int().positive(),
    rating: z.number({ error: 'Choose 1 to 5 stars' }).int({ error: 'Choose 1 to 5 stars' }).min(1, { error: 'Choose 1 to 5 stars' }).max(5, { error: 'Choose 1 to 5 stars' }),
    body: z.string().max(4000).nullable().default(null),
    photoIds: z
      .array(z.number().int().positive())
      .max(MAX_REVIEW_PHOTOS, { error: `At most ${MAX_REVIEW_PHOTOS} photos` })
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  .meta({ id: 'StoreReviewBody' });

/** Write or change their review. It waits for staff again (a changed review is checked again). */
reviewsRouter.post('/me/reviews', writeLimiter, async (req, res) => {
  const c = await signedIn(req);
  await ownWords(req);
  const input = reviewBody.parse(req.body);
  const [p] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, input.productId), eq(products.status, 'active')));
  if (!p) throw notFound('Product not found');
  const orderId = await deliveredOrderWith(c.id, p.id);
  if (!orderId) throw conflict('Only customers who received this product can review it.');
  const body = cleanText(input.body, 2000);

  const [existing] = await db.select().from(productReviews).where(and(eq(productReviews.productId, p.id), eq(productReviews.customerId, c.id)));
  // Photos: their own uploads, and not used by another of their reviews.
  if (input.photoIds.length) {
    const own = await db
      .select({ id: media.id })
      .from(media)
      .where(
        and(
          inArray(media.id, input.photoIds),
          eq(media.customerId, c.id),
          notExists(
            db
              .select({ one: sql`1` })
              .from(productReviews)
              .where(and(sql`${media.id} = any(${productReviews.photoIds})`, existing ? sql`${productReviews.id} <> ${existing.id}` : undefined)),
          ),
        ),
      );
    if (own.length !== input.photoIds.length) throw badRequest('A photo could not be used. Please add it again.', { photoIds: 'Add the photo again' });
  }

  const values = { rating: input.rating, body, photoIds: input.photoIds, orderId, status: 'pending' as const, rejectReason: null, decidedBy: null, decidedAt: null, updatedAt: new Date() };
  const [row] = existing
    ? await db.update(productReviews).set(values).where(eq(productReviews.id, existing.id)).returning()
    : await db.insert(productReviews).values({ ...values, productId: p.id, customerId: c.id }).returning();
  // An approved review that changed leaves the count until it is approved again.
  if (existing?.status === 'approved') await refreshRating(p.id);
  res.status(existing ? 200 : 201).json({ id: row!.id, status: row!.status });
});

/** Delete their review. */
reviewsRouter.delete('/me/reviews/:id', async (req, res) => {
  const c = await signedIn(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound('Review not found');
  const [row] = await db
    .delete(productReviews)
    .where(and(eq(productReviews.id, id), eq(productReviews.customerId, c.id)))
    .returning({ productId: productReviews.productId, status: productReviews.status });
  if (!row) throw notFound('Review not found');
  if (row.status === 'approved') await refreshRating(row.productId);
  res.status(204).end();
});

/** Unused review photos (uploaded, never sent with a review) older than a day: what a clean-up may remove. */
export const strayPhotos = () =>
  db
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        sql`${media.customerId} is not null`,
        sql`${media.createdAt} < now() - interval '1 day'`,
        notExists(db.select({ one: sql`1` }).from(productReviews).where(sql`${media.id} = any(${productReviews.photoIds})`)),
        isNull(media.uploadedBy),
      ),
    );
