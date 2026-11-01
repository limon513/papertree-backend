import { inArray } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { media } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import { storage } from '../../../lib/storage.ts';

type MediaRow = typeof media.$inferSelect;

export const variantKey = (keyBase: string, width: number) => `${keyBase}-${width}.webp`;

/** What the API returns for an image: its public URL in every saved width. */
export function mediaView(m: MediaRow) {
  const urls = Object.fromEntries(m.widths.map((w) => [String(w), storage.url(variantKey(m.keyBase, w))]));
  return {
    id: m.id,
    url: urls[String(m.widths[m.widths.length - 1])]!,
    urls,
    width: m.width,
    height: m.height,
    alt: m.alt,
    originalName: m.originalName,
  };
}

export type MediaView = ReturnType<typeof mediaView>;

/** Adds `image` to rows that have an `imageId`, with one database query for all of them. */
export async function withImages<T extends { imageId: number | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.imageId).filter((id): id is number => id !== null))];
  const found = ids.length ? await db.select().from(media).where(inArray(media.id, ids)) : [];
  const byId = new Map(found.map((m) => [m.id, mediaView(m)]));
  return rows.map((r) => ({ ...r, image: r.imageId === null ? null : (byId.get(r.imageId) ?? null) }));
}

export async function withImage<T extends { imageId: number | null }>(row: T) {
  return (await withImages([row]))[0]!;
}

/** Checks that an `imageId` sent with a form points to an uploaded image. */
export async function checkImageId(imageId: number | null | undefined) {
  if (imageId === null || imageId === undefined) return;
  const [row] = await db.select({ id: media.id }).from(media).where(inArray(media.id, [imageId])).limit(1);
  if (!row) throw badRequest('The image was not found. Upload it again.', { imageId: 'Upload the image again' });
}
