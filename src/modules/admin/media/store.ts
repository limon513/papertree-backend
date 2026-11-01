import { db } from '../../../db/client.ts';
import { media } from '../../../db/schema/index.ts';
import { randomToken } from '../../../lib/crypto.ts';
import { slugify } from '../../../lib/slug.ts';
import { storage } from '../../../lib/storage.ts';
import { processImage } from './process.ts';
import { variantKey } from './view.ts';

/** Resizes an image, saves every width to storage and records it. Returns the media row. */
export async function storeImage(input: Buffer, originalName: string, uploadedBy: number | null) {
  const image = await processImage(input);

  // e.g. media/2026/11/x7k2p9q4-faber-logo
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const name = slugify(originalName.replace(/\.[^.]+$/, '')).slice(0, 60) || 'image';
  const keyBase = `media/${now.getUTCFullYear()}/${month}/${randomToken(6).toLowerCase()}-${name}`;

  await Promise.all(image.variants.map((v) => storage.put(variantKey(keyBase, v.width), v.body, 'image/webp')));

  const [row] = await db
    .insert(media)
    .values({
      keyBase,
      widths: image.variants.map((v) => v.width),
      width: image.width,
      height: image.height,
      sizeBytes: image.variants.reduce((sum, v) => sum + v.body.length, 0),
      originalName: originalName.slice(0, 200),
      uploadedBy,
    })
    .returning();
  return row!;
}
