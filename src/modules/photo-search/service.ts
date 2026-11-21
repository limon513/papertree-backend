import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../db/client.ts';
import { photoSearches } from '../../db/schema/index.ts';
import { badRequest } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { storage } from '../../lib/storage.ts';
import { variantKey } from '../admin/media/view.ts';
import { activeCategories, cards } from '../store/catalog.ts';
import { asVector, embed, IMAGE_MODEL } from './model.ts';

/**
 * Search by photo.
 * - Every product picture is turned into numbers in the background (indexPictures, job photo-index).
 * - A shopper's photo is looked at twice: whole, and zoomed into the middle (a product small on a
 *   table is found almost always that way; in our tests 97% first, against 29% from the whole photo).
 * - Products whose pictures are closest come first. How close says whether it looks like the same
 *   item ("same"), a close one ("close"), or only something similar ("similar").
 */

/** Score levels (0–1), measured on the shop's own pictures. */
export const SAME_ITEM = 0.86;
export const CLOSE_MATCH = 0.8;
/**
 * The first result is also a close match when it is clearly ahead of the second: in our tests a lead of
 * 0.05 at 0.70 or more was always the right product (dim, blurry or small in the photo), and plain
 * walls or blurs never had it.
 */
const CLEAR_LEAD = 0.05;
const LEAD_FLOOR = 0.7;
/** Below this a product is not shown at all, unless there would be too few. */
const FLOOR = 0.62;
const MIN_SHOWN = 12;
const MAX_SHOWN = 48;
/** Photos with no close match are kept this long for staff (the search report). */
export const PHOTO_KEEP_DAYS = 30;
const MAX_KEPT_A_DAY = 300;

export type MatchLevel = 'same' | 'close' | 'similar';
export const levelOf = (score: number): MatchLevel => (score >= SAME_ITEM ? 'same' : score >= CLOSE_MATCH ? 'close' : 'similar');

// ---- Product pictures (background) ----

/** Pictures of products (custom items aside) with no numbers from today's model yet. */
const MISSING = sql`
  from media m
  where exists (select 1 from product_images pi join products p on p.id = pi.product_id and not p.is_custom where pi.media_id = m.id)
    and not exists (select 1 from image_vectors iv where iv.media_id = m.id and iv.model = ${IMAGE_MODEL})`;

/** How many product pictures are ready for search by photo. */
export async function pictureCounts() {
  const { rows } = await db.execute<{ total: string; missing: string }>(sql`
    select
      (select count(distinct pi.media_id) from product_images pi join products p on p.id = pi.product_id and not p.is_custom) as total,
      (select count(*) ${MISSING}) as missing`);
  const total = Number(rows[0]?.total ?? 0);
  return { total, ready: total - Number(rows[0]?.missing ?? 0) };
}

/** The picture's saved width closest to 400 px (enough for the model's 224 px; small to download). */
const widthFor = (widths: number[]) => widths.find((w) => w >= 400) ?? widths[widths.length - 1]!;

/**
 * Turns product pictures without numbers into numbers, newest first, up to `max` per run. Returns how
 * many were done and whether more are waiting. A picture that cannot be read is skipped this run.
 */
export async function indexPictures(max = 200) {
  const { rows } = await db.execute<{ id: string; key_base: string; widths: number[] }>(sql`select m.id, m.key_base, m.widths ${MISSING} order by m.id desc limit ${max}`);
  let done = 0;
  for (const m of rows) {
    try {
      const res = await fetch(storage.url(variantKey(m.key_base, widthFor(m.widths))), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`picture download failed (${res.status})`);
      const v = asVector(await embed(Buffer.from(await res.arrayBuffer())));
      await db.execute(sql`
        insert into image_vectors (media_id, model, embedding) values (${Number(m.id)}, ${IMAGE_MODEL}, ${v}::vector)
        on conflict (media_id) do update set model = excluded.model, embedding = excluded.embedding, created_at = now()`);
      done++;
    } catch (err) {
      logger.warn({ err, mediaId: m.id }, 'Photo search: a product picture could not be read');
    }
  }
  if (done) logger.info({ done }, 'Photo search: product pictures added');
  return { done, more: rows.length === max && done > 0 };
}

// ---- Finding ----

/** Products whose pictures look most like any of the given looks (best picture counts), best first. */
async function closest(looks: number[][], exceptProductId: number | null, limit: number) {
  const scores = looks.map((l) => sql`1 - (iv.embedding <=> ${asVector(l)}::vector)`);
  const { rows } = await db.execute<{ product_id: string; score: number }>(sql`
    select pi.product_id, max(${scores.length > 1 ? sql`greatest(${sql.join(scores, sql`, `)})` : scores[0]!}) as score
    from image_vectors iv
    join product_images pi on pi.media_id = iv.media_id
    join products p on p.id = pi.product_id and p.status = 'active' and not p.is_custom
    where iv.model = ${IMAGE_MODEL} ${exceptProductId ? sql`and pi.product_id <> ${exceptProductId}` : sql``}
    group by pi.product_id
    order by score desc
    limit ${limit}`);
  return rows.map((r) => ({ productId: Number(r.product_id), score: Number(r.score) }));
}

/** Product cards for the found products, in score order, each with its match level and main category. */
async function withCards(found: { productId: number; score: number }[]) {
  if (!found.length) return { items: [], categories: [] };
  const ids = found.map((f) => f.productId);
  const [{ items }, cats, { rows: primary }] = await Promise.all([
    cards(sql`c.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, sql`c.id`, ids.length),
    activeCategories(),
    db.execute<{ product_id: string; category_id: string }>(sql`
      select distinct on (product_id) product_id, category_id from product_categories
      where product_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) order by product_id, is_primary desc, category_id`),
  ]);
  const card = new Map(items.map((c) => [c.id, c]));
  const categoryOf = new Map(primary.map((r) => [Number(r.product_id), cats.byId.get(Number(r.category_id))]));
  const list = found.flatMap((f, i) => {
    const c = card.get(f.productId);
    if (!c) return [];
    const cat = categoryOf.get(f.productId);
    let match = levelOf(f.score);
    if (i === 0 && match === 'similar' && f.score >= LEAD_FLOOR && f.score - (found[1]?.score ?? 0) >= CLEAR_LEAD) match = 'close';
    return [{ ...c, score: Math.round(f.score * 1000) / 1000, match, category: cat ? { name: cat.name, slug: cat.slug } : null }];
  });
  // Filter chips: the categories among the results, most results first.
  const counts = new Map<string, { name: string; slug: string; count: number }>();
  for (const i of list) if (i.category) counts.set(i.category.slug, { ...i.category, count: (counts.get(i.category.slug)?.count ?? 0) + 1 });
  return { items: list, categories: [...counts.values()].sort((a, b) => b.count - a.count) };
}

/** Keeps the useful part of a ranked list: everything close, and enough "similar" to browse. */
function trim(found: { productId: number; score: number }[]) {
  const best = found[0]?.score ?? 0;
  const keep = found.filter((f, i) => i < MIN_SHOWN || (f.score >= FLOOR && f.score >= best - 0.18));
  return keep.slice(0, MAX_SHOWN);
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A shopper's photo made ready: upright, no transparency, at most 1024 px, as JPEG. Throws a friendly
 * error when the file is not a picture we can read.
 */
export async function preparePhoto(file: Buffer) {
  try {
    const { data, info } = await sharp(file, { limitInputPixels: 50_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    if (info.width < 32 || info.height < 32) throw new Error('too small');
    return { jpeg: data, width: info.width, height: info.height };
  } catch {
    throw badRequest('We could not read this photo. Please use a JPG or PNG picture.', { photo: 'We could not read this photo' });
  }
}

/** The part of the photo inside the box (fractions of the width and height), at least 24 px. */
function region(photo: { jpeg: Buffer; width: number; height: number }, crop: Crop | null) {
  if (!crop) return { left: 0, top: 0, width: photo.width, height: photo.height };
  const left = Math.min(photo.width - 24, Math.max(0, Math.round(crop.x * photo.width)));
  const top = Math.min(photo.height - 24, Math.max(0, Math.round(crop.y * photo.height)));
  return {
    left,
    top,
    width: Math.max(24, Math.min(photo.width - left, Math.round(crop.w * photo.width))),
    height: Math.max(24, Math.min(photo.height - top, Math.round(crop.h * photo.height))),
  };
}

/**
 * Where the item probably is: the part of the photo that differs from its edges (the table, the
 * wall, the hand around it). A small picture of the photo is compared with the colour of its border;
 * the box around what differs (ignoring stray specks) is the item. Null when nothing stands out
 * clearly (a busy background, or the item already fills the photo).
 */
export async function findFocus(jpeg: Buffer): Promise<Crop | null> {
  const N = 64;
  const { data } = await sharp(jpeg).resize(N, N, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => [data[(y * N + x) * 3]!, data[(y * N + x) * 3 + 1]!, data[(y * N + x) * 3 + 2]!] as const;
  // The background: the middle value of the border, per colour.
  const border: (readonly [number, number, number])[] = [];
  for (let i = 0; i < N; i++) border.push(px(i, 0), px(i, N - 1), px(0, i), px(N - 1, i));
  const median = [0, 1, 2].map((c) => border.map((p) => p[c]!).sort((a, b) => a - b)[border.length >> 1]!);
  // How much of the border itself looks like that background: a busy background has no single colour.
  const near = (p: readonly number[]) => Math.max(Math.abs(p[0]! - median[0]!), Math.abs(p[1]! - median[1]!), Math.abs(p[2]! - median[2]!));
  if (border.filter((p) => near(p) < 36).length < border.length * 0.6) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (near(px(x, y)) >= 48) xs.push(x), ys.push(y);
  if (xs.length < N * N * 0.02) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const at = (list: number[], f: number) => list[Math.min(list.length - 1, Math.floor(list.length * f))]!;
  const pad = 0.06;
  const x0 = Math.max(0, at(xs, 0.02) / N - pad);
  const y0 = Math.max(0, at(ys, 0.02) / N - pad);
  const x1 = Math.min(1, (at(xs, 0.98) + 1) / N + pad);
  const y1 = Math.min(1, (at(ys, 0.98) + 1) / N + pad);
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  // Nearly the whole photo, or a speck: not useful.
  if (box.w * box.h > 0.8 || box.w < 0.08 || box.h < 0.08) return null;
  return box;
}

/**
 * Searches with a shopper's photo (already prepared), optionally only the part inside a box. Two
 * looks: the whole photo (or box), and a closer one at the item (found by findFocus), or else at the
 * middle 60% (a product small in the frame then fills the model's view). Returns `focus`: where the
 * closer look was, so the website can show that box.
 */
export async function searchByPhoto(photo: { jpeg: Buffer; width: number; height: number }, crop: Crop | null) {
  const r = region(photo, crop);
  const focus = crop ? null : await findFocus(photo.jpeg).catch(() => null);
  const closer = focus
    ? region(photo, focus)
    : { left: r.left + Math.round(r.width * 0.2), top: r.top + Math.round(r.height * 0.2), width: Math.max(16, Math.round(r.width * 0.6)), height: Math.max(16, Math.round(r.height * 0.6)) };
  const whole = await embed(sharp(photo.jpeg).extract(r));
  const near = await embed(sharp(photo.jpeg).extract(closer));
  const found = trim(await closest([whole, near], null, MAX_SHOWN));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { ...(await withCards(found)), focus: focus ? { x: round(focus.x), y: round(focus.y), w: round(focus.w), h: round(focus.h) } : null };
}

/** Products that look like this one (its main picture), for "Similar items". */
export async function similarTo(productId: number, limit = 24) {
  const { rows } = await db.execute<{ embedding: string }>(sql`
    select iv.embedding::text as embedding from product_images pi join image_vectors iv on iv.media_id = pi.media_id and iv.model = ${IMAGE_MODEL}
    where pi.product_id = ${productId} order by pi.position limit 1`);
  if (!rows[0]) return { items: [], categories: [] };
  const look = JSON.parse(rows[0].embedding) as number[];
  const found = (await closest([look], productId, limit)).filter((f) => f.score >= FLOOR);
  return withCards(found);
}

/**
 * Records a photo search for the report. The photo is kept (30 days) only when nothing close was
 * found: that shows staff what shoppers want that the shop does not have.
 */
export async function logPhotoSearch(input: {
  jpeg: Buffer;
  items: { id: number; score: number; match: MatchLevel }[];
  cropped: boolean;
  customerId: number | null;
  device: string | null;
}) {
  const best = input.items[0];
  const matched = !!best && best.match !== 'similar';
  let photoKey: string | null = null;
  // At most this many kept a day: a robot sending junk photos cannot fill the storage.
  const { rows: today } = matched ? { rows: [] } : await db.execute<{ n: string }>(sql`select count(*) as n from photo_searches where photo_key is not null and created_at > now() - interval '1 day'`);
  if (!matched && Number(today[0]?.n ?? 0) < MAX_KEPT_A_DAY) {
    photoKey = `photo-search/${new Date().toISOString().slice(0, 7)}/${randomBytes(24).toString('hex')}.jpg`;
    try {
      await storage.put(photoKey, input.jpeg, 'image/jpeg');
    } catch (err) {
      logger.warn({ err }, 'Photo search: the photo could not be kept');
      photoKey = null;
    }
  }
  const [row] = await db
    .insert(photoSearches)
    .values({
      results: input.items.length,
      bestScore: best?.score ?? null,
      matched,
      cropped: input.cropped,
      bestProductId: best?.id ?? null,
      customerId: input.customerId,
      device: input.device,
      photoKey,
    })
    .returning({ id: photoSearches.id });
  return row!.id;
}

/** Kept photos older than 30 days go (the daily clean-up). */
export async function removeOldPhotos() {
  const { rows } = await db.execute<{ id: string; photo_key: string }>(sql`
    select id, photo_key from photo_searches where photo_key is not null and created_at < now() - make_interval(days => ${PHOTO_KEEP_DAYS}) limit 2000`);
  for (const r of rows) {
    try {
      await storage.remove(r.photo_key);
      await db.execute(sql`update photo_searches set photo_key = null where id = ${Number(r.id)}`);
    } catch (err) {
      logger.warn({ err, id: r.id }, 'Photo search: an old photo could not be removed');
    }
  }
  return rows.length;
}
