import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import {
  brands,
  categories,
  importJobs,
  importRows,
  products,
  productVariants,
  stockLocations,
} from '../../../db/schema/index.ts';
import { AppError } from '../../../lib/errors.ts';
import { logger } from '../../../lib/logger.ts';
import { FetchError, fetchPublic } from '../../../lib/safe-fetch.ts';
import { freeSlug, slugify } from '../../../lib/slug.ts';
import { storeImage } from '../media/store.ts';
import { productBody } from '../products/schemas.ts';
import { saveProduct, setVariantStock } from '../products/service.ts';
import { categoryPathIndex, pathKey, toProductBody } from './prepare.ts';
import type { ImportProduct } from './types.ts';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

type Job = typeof importJobs.$inferSelect;

/** Things looked up once per import and reused for every product. */
interface Context {
  job: Job;
  locationId: number;
  categoryIndex: Map<string, number>;
  categorySlugs: Set<string>;
  brandIds: Map<string, number>;
  brandSlugs: Set<string>;
  /** Image link -> uploaded media id (or the reason it failed), so each link is downloaded once. */
  images: Map<string, Promise<number | string>>;
}

/** Text for a failed row: the field messages if there are any, else the error message. */
function describe(err: unknown) {
  if (err instanceof AppError) {
    const fields = err.details && typeof err.details === 'object' ? Object.values(err.details as Record<string, string>) : [];
    return fields.length ? fields.join('; ') : err.message;
  }
  logger.error({ err }, 'Import row failed');
  return err instanceof Error ? err.message : 'Unknown error';
}

/** Finds or creates a category path like Paper > Art Paper. Returns the last one's id. */
async function ensureCategory(ctx: Context, path: string[]) {
  let parentId: number | null = null;
  for (let depth = 1; depth <= path.length; depth++) {
    const key = pathKey(path.slice(0, depth));
    let id = ctx.categoryIndex.get(key);
    if (id === undefined) {
      const name = path[depth - 1]!.slice(0, 100);
      const slug = freeSlug(slugify(name) || 'category', ctx.categorySlugs);
      const [{ next } = { next: 0 }] = await db
        .select({ next: sql<number>`coalesce(max(${categories.sortOrder}) + 1, 0)`.mapWith(Number) })
        .from(categories)
        .where(parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, parentId));
      const created: { id: number }[] = await db
        .insert(categories)
        .values({ name, slug, parentId, sortOrder: next })
        .returning({ id: categories.id });
      const newId = created[0]!.id;
      id = newId;
      ctx.categoryIndex.set(key, newId);
      ctx.categorySlugs.add(slug);
    }
    parentId = id;
  }
  return parentId!;
}

async function ensureBrand(ctx: Context, name: string) {
  const key = name.toLowerCase();
  let id = ctx.brandIds.get(key);
  if (id === undefined) {
    const slug = freeSlug(slugify(name) || 'brand', ctx.brandSlugs);
    const [row] = await db.insert(brands).values({ name: name.slice(0, 100), slug }).returning({ id: brands.id });
    id = row!.id;
    ctx.brandIds.set(key, id);
    ctx.brandSlugs.add(slug);
  }
  return id;
}

/** Downloads an image link and stores it. Resolves to the media id, or the reason it failed. */
function image(ctx: Context, url: string) {
  let pending = ctx.images.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const { body } = await fetchPublic(url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/*' });
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'image');
        const media = await storeImage(body, name, ctx.job.createdBy);
        return media.id;
      } catch (err) {
        return err instanceof FetchError || err instanceof AppError ? err.message : 'Could not be saved';
      }
    })();
    ctx.images.set(url, pending);
  }
  return pending;
}

/** Runs `work` on every item, at most `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) results.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return results;
}

async function createProduct(ctx: Context, p: ImportProduct) {
  const categoryIds = [];
  for (const path of p.categories) categoryIds.push(await ensureCategory(ctx, path.slice(0, 3)));
  const brandId = p.brand ? await ensureBrand(ctx, p.brand) : null;

  const links = [...new Set([...p.images, ...p.variants.flatMap((v) => (v.image ? [v.image] : []))])];
  const results = await inBatches(links, 4, (url) => image(ctx, url));
  const mediaFor = new Map(links.map((url, i) => [url, results[i]!]));
  const failedImages = links.filter((url) => typeof mediaFor.get(url) === 'string');
  const id = (url: string | null) => {
    const m = url ? mediaFor.get(url) : undefined;
    return typeof m === 'number' ? m : null;
  };

  const base = toProductBody(p, ctx.job.options.status === 'draft' ? 'draft' : p.status);
  const input = productBody.parse({
    ...base,
    brandId,
    categoryIds: [...new Set(categoryIds)],
    imageIds: [...new Set(p.images.map(id).filter((x): x is number => x !== null))].slice(0, 20),
    variants: base.variants.map((v, i) => {
      const source = p.variants[i]!;
      return {
        ...v,
        imageId: id(source.image),
        stock: source.stock === null ? [] : [{ locationId: ctx.locationId, quantity: source.stock }],
      };
    }),
  });
  const productId = await saveProduct(input, ctx.job.createdBy);
  const note = failedImages.length
    ? `${failedImages.length} image${failedImages.length === 1 ? '' : 's'} could not be downloaded (${mediaFor.get(failedImages[0]!)})`
    : null;
  return { productId, note };
}

/** Updates price and stock of the variants whose SKU is already in the shop. */
async function updateProduct(ctx: Context, p: ImportProduct) {
  const skus = p.variants.flatMap((v) => (v.sku ? [v.sku.toLowerCase()] : []));
  const existing = await db
    .select({ id: productVariants.id, productId: productVariants.productId, sku: productVariants.sku })
    .from(productVariants)
    .where(inArray(sql`lower(${productVariants.sku})`, skus));

  let productId: number | null = null;
  for (const v of p.variants) {
    const match = existing.find((e) => e.sku?.toLowerCase() === v.sku?.toLowerCase());
    if (!match) continue;
    productId ??= match.productId;
    // Only cells that have a value change anything.
    const changes = {
      ...(v.price !== null && { price: v.price }),
      ...(v.salePrice !== null && { salePrice: v.salePrice }),
      ...(v.wholesalePrice !== null && { wholesalePrice: v.wholesalePrice }),
      ...(v.costPrice !== null && { costPrice: v.costPrice }),
      ...(v.weightGrams !== null && { weightGrams: v.weightGrams }),
    };
    if (Object.keys(changes).length) await db.update(productVariants).set(changes).where(eq(productVariants.id, match.id));
    if (v.stock !== null) {
      await setVariantStock(match.id, ctx.locationId, v.stock, 'import', ctx.job.createdBy, `Import #${ctx.job.id}`);
    }
  }
  if (productId !== null) {
    const status = ctx.job.options.status === 'file' && p.status ? p.status : undefined;
    await db
      .update(products)
      .set({ updatedAt: new Date(), ...(status && { status }) })
      .where(eq(products.id, productId));
  }
  return { productId, note: null };
}

const bump = (field: 'created' | 'updated' | 'skipped' | 'failed') => ({
  processed: sql`${importJobs.processed} + 1`,
  [field]: sql`${importJobs[field]} + 1`,
});

/** Imports every waiting row of an import. Safe to run again after a crash: finished rows are skipped. */
export async function runImport(jobId: number, signal?: AbortSignal) {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
  if (!job || !['queued', 'running'].includes(job.status)) return;

  await db
    .update(importJobs)
    .set({ status: 'running', startedAt: job.startedAt ?? new Date() })
    .where(eq(importJobs.id, jobId));

  try {
    const [location] = await db
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .orderBy(sql`${stockLocations.isDefault} desc`, asc(stockLocations.id))
      .limit(1);
    const [allCategories, allBrands] = await Promise.all([
      db.select({ slug: categories.slug }).from(categories),
      db.select({ name: brands.name, id: brands.id, slug: brands.slug }).from(brands),
    ]);
    const ctx: Context = {
      job,
      locationId: location!.id,
      categoryIndex: await categoryPathIndex(),
      categorySlugs: new Set(allCategories.map((c) => c.slug)),
      brandIds: new Map(allBrands.map((b) => [b.name.toLowerCase(), b.id])),
      brandSlugs: new Set(allBrands.map((b) => b.slug)),
      images: new Map(),
    };

    const rows = await db
      .select()
      .from(importRows)
      .where(and(eq(importRows.jobId, jobId), eq(importRows.status, 'pending')))
      .orderBy(asc(importRows.position));

    for (const [i, row] of rows.entries()) {
      // Stop when the server shuts down (the job continues after the restart) or the import is cancelled.
      if (signal?.aborted) return;
      if (i % 10 === 0) {
        const [now] = await db.select({ status: importJobs.status }).from(importJobs).where(eq(importJobs.id, jobId));
        if (now?.status === 'cancelled') return;
      }

      if (row.action === 'skip' || row.action === 'error') {
        const field = row.action === 'skip' ? 'skipped' : 'failed';
        await db.update(importRows).set({ status: field === 'skipped' ? 'skipped' : 'failed' }).where(eq(importRows.id, row.id));
        await db.update(importJobs).set(bump(field)).where(eq(importJobs.id, jobId));
        continue;
      }

      try {
        const product = row.data as ImportProduct;
        const result = row.action === 'create' ? await createProduct(ctx, product) : await updateProduct(ctx, product);
        await db
          .update(importRows)
          .set({ status: 'done', productId: result.productId, message: result.note ?? row.message })
          .where(eq(importRows.id, row.id));
        await db.update(importJobs).set(bump(row.action === 'create' ? 'created' : 'updated')).where(eq(importJobs.id, jobId));
      } catch (err) {
        await db.update(importRows).set({ status: 'failed', message: describe(err) }).where(eq(importRows.id, row.id));
        await db.update(importJobs).set(bump('failed')).where(eq(importJobs.id, jobId));
      }
    }

    await db
      .update(importJobs)
      .set({ status: 'done', finishedAt: new Date() })
      .where(and(eq(importJobs.id, jobId), eq(importJobs.status, 'running')));
  } catch (err) {
    logger.error({ err, jobId }, 'Import stopped');
    await db
      .update(importJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: err instanceof Error ? err.message : 'Unknown error' })
      .where(eq(importJobs.id, jobId));
  }
}
