import { sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { brands, importJobs, importRows } from '../../../db/schema/index.ts';
import { inBatches } from '../../../lib/batches.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { productBody } from '../products/schemas.ts';
import { saveProduct } from '../products/service.ts';
import { downloadImage } from './run.ts';
import type { LinkCreateInput } from './schemas.ts';

/** The brand with this name, created if we don't have it yet. */
async function brandFor(name: string) {
  const [found] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(sql`lower(${brands.name}) = ${name.toLowerCase()}`);
  if (found) return found.id;
  const taken = new Set((await db.select({ slug: brands.slug }).from(brands)).map((b) => b.slug));
  const [row] = await db
    .insert(brands)
    .values({ name, slug: freeSlug(slugify(name) || 'brand', taken) })
    .returning({ id: brands.id });
  return row!.id;
}

/**
 * Saves a product copied from a web page as a draft: downloads the chosen pictures, creates the
 * product, and adds it to the import history so it is clear where it came from.
 */
export async function saveLinkProduct(input: LinkCreateInput, adminUserId: number) {
  const body = (imageIds: number[], variantImage: (url: string | null) => number | null, brandId: number | null) =>
    productBody.parse({
      name: input.name,
      status: 'draft',
      shortDescription: input.shortDescription,
      description: input.description,
      brandId,
      categoryIds: input.categoryIds,
      tags: input.tags.map((t) => t.trim().slice(0, 50)).filter(Boolean),
      imageIds,
      options: input.options,
      specs: input.specs.map((s) => ({ name: s.name.slice(0, 60), value: s.value.slice(0, 200) })),
      variants: input.variants.map((v) => ({
        option1: v.values[0] ?? null,
        option2: v.values[1] ?? null,
        option3: v.values[2] ?? null,
        price: v.price,
        salePrice: v.salePrice,
        imageId: variantImage(v.image),
      })),
    });

  // Check everything before downloading pictures, so a mistake costs nothing.
  body([], () => null, input.brandId);

  const brandId = input.brandId ?? (input.newBrand ? await brandFor(input.newBrand) : null);

  const links = [...new Set([...input.images, ...input.variants.flatMap((v) => (v.image ? [v.image] : []))])];
  const results = await inBatches(links, 4, (url) => downloadImage(url, adminUserId));
  const media = new Map(links.map((url, i) => [url, results[i]!]));
  const id = (url: string | null) => {
    const m = url ? media.get(url) : undefined;
    return typeof m === 'number' ? m : null;
  };
  const failed = links.filter((url) => typeof media.get(url) === 'string');

  const productId = await saveProduct(
    body(
      input.images.map(id).filter((x): x is number => x !== null),
      id,
      brandId,
    ),
    adminUserId,
  );

  const note = failed.length
    ? `${failed.length} picture${failed.length === 1 ? '' : 's'} could not be downloaded (${media.get(failed[0]!)})`
    : null;

  const now = new Date();
  const importId = await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(importJobs)
      .values({
        status: 'done',
        fileName: input.url.slice(0, 500),
        format: 'link',
        options: { existing: 'skip', status: 'draft', createMissing: !!input.newBrand },
        total: 1,
        processed: 1,
        created: 1,
        createdBy: adminUserId,
        startedAt: now,
        finishedAt: now,
      })
      .returning({ id: importJobs.id });
    await tx.insert(importRows).values({
      jobId: job!.id,
      position: 0,
      lines: [],
      name: input.name.slice(0, 300),
      action: 'create',
      status: 'done',
      message: note,
      data: input,
      productId,
    });
    return job!.id;
  });

  return { productId, importId, note };
}
