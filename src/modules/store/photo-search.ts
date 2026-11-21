import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { productRequests, products } from '../../db/schema/index.ts';
import { badRequest, notFound, serviceUnavailable } from '../../lib/errors.ts';
import { parseId } from '../../lib/ids.ts';
import { logger } from '../../lib/logger.ts';
import { storage } from '../../lib/storage.ts';
import { logPhotoSearch, pictureCounts, preparePhoto, searchByPhoto, similarTo, type Crop } from '../photo-search/service.ts';
import { deviceOf, recordSearch, whose } from './activity.ts';
import { productRequestBody } from './schemas.ts';

/**
 * Search by photo, for the website: a photo (from the camera or gallery, made small by the browser
 * first) finds the products that look like it. Also "Similar items" for a product, and "Ask us to find
 * it" with the photo when nothing matches.
 */
export const photoSearchRouter = Router();

const MAX_MB = 8;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 10 } });
const onePhoto = (req: Request, res: Response, next: NextFunction) =>
  upload.single('photo')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(badRequest(`Photos up to ${MAX_MB} MB`, { photo: `Photos up to ${MAX_MB} MB` }));
    next(err);
  });

/** Plenty for a person moving the box around; not for a robot. */
const searchLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many photo searches. Please wait a few minutes.' } },
});
const requestLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'You have sent several requests already. Please call or WhatsApp us instead.' } },
});

/** JPG, PNG, WebP, GIF, AVIF or HEIC, from the file's first bytes (never its name). */
function isPicture(b: Buffer) {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return true;
  if (b.toString('ascii', 0, 3) === 'GIF') return true;
  return b.toString('ascii', 4, 8) === 'ftyp';
}

function photoOf(req: Request) {
  if (!env.PHOTO_SEARCH) throw serviceUnavailable('Search by photo is switched off');
  if (!req.file) throw badRequest('Choose a photo', { photo: 'Choose a photo' });
  if (!isPicture(req.file.buffer)) throw badRequest('Please use a JPG or PNG picture.', { photo: 'Please use a JPG or PNG picture' });
  return preparePhoto(req.file.buffer);
}

/** "x,y,w,h" as fractions of the photo (0–1): the box the shopper drew. Anything odd = the whole photo. */
const cropField = z
  .string()
  .regex(/^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/)
  .transform((s) => {
    const [x, y, w, h] = s.split(',').map(Number) as [number, number, number, number];
    return { x, y, w, h };
  })
  .refine((c) => [c.x, c.y, c.w, c.h].every((n) => n >= 0 && n <= 1) && c.w >= 0.05 && c.h >= 0.05 && c.x + c.w <= 1.001 && c.y + c.h <= 1.001)
  .nullable()
  .catch(null);

/** Is search by photo ready? (switched on, and product pictures read) Kept a few minutes. */
let readyCache: { at: number; ready: boolean } | null = null;
export async function photoSearchReady() {
  if (!env.PHOTO_SEARCH) return false;
  if (readyCache && Date.now() - readyCache.at < 5 * 60_000) return readyCache.ready;
  const { ready } = await pictureCounts().catch(() => ({ ready: 0 }));
  readyCache = { at: Date.now(), ready: ready > 0 };
  return readyCache.ready;
}

/** Search with a photo. Field "photo" (the picture), optional "crop" ("x,y,w,h", fractions). */
photoSearchRouter.post('/photo-search', searchLimiter, onePhoto, async (req, res) => {
  const photo = await photoOf(req);
  const crop: Crop | null = cropField.parse(typeof req.body?.crop === 'string' ? req.body.crop : null);
  const found = await searchByPhoto(photo, crop);
  res.set('cache-control', 'no-store').json(found);
  // Recorded after answering: the shopper does not wait for it.
  void (async () => {
    const customer = await whose(req);
    await logPhotoSearch({ jpeg: photo.jpeg, items: found.items, cropped: !!crop, customerId: customer?.id ?? null, device: deviceOf(req.get('user-agent')) });
    await recordSearch(req, '📷 a photo');
  })().catch((err) => logger.warn({ err }, 'Photo search: could not record the search'));
});

/** Products that look like this one (for "Similar items" and "Find similar"). */
photoSearchRouter.get('/photo-search/similar/:productId', async (req, res) => {
  const id = parseId(req.params.productId);
  const [p] = await db
    .select({ id: products.id, name: products.name, slug: products.slug })
    .from(products)
    .where(and(eq(products.id, id), eq(products.status, 'active'), eq(products.isCustom, false)));
  if (!p) throw notFound('Product not found');
  const found = await similarTo(p.id, 48);
  res.set('cache-control', 'public, max-age=300, stale-while-revalidate=1500').json({ product: p, ...found });
});

/** "Ask us to find it": a product request with the photo (staff see it in Requests & Leads). */
photoSearchRouter.post('/photo-search/request', requestLimiter, onePhoto, async (req, res) => {
  const photo = await photoOf(req);
  const { website, ...input } = productRequestBody.parse({ ...req.body, query: null });
  // The hidden box was filled: a bot. Answer as if saved.
  if (!website) {
    const key = `photo-requests/${new Date().toISOString().slice(0, 7)}/${randomBytes(24).toString('hex')}.jpg`;
    await storage.put(key, photo.jpeg, 'image/jpeg');
    await db.insert(productRequests).values({ ...input, query: '📷 search by photo', photoKey: key });
  }
  res.status(201).json({ ok: true });
});

