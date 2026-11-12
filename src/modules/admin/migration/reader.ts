import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { categories, importJobs, importRows, oldSiteRuns, oldSiteUrls, type OldUrlKind } from '../../../db/schema/index.ts';
import { decodeEntities } from '../../../lib/html.ts';
import { logger } from '../../../lib/logger.ts';
import { cleanPath } from '../../../lib/paths.ts';
import { fetchPublic } from '../../../lib/safe-fetch.ts';
import { fromWooStore, isObject, list, type Json } from '../imports/link.ts';
import { prepareImport } from '../imports/prepare.ts';
import type { ImportProduct, ImportVariant } from '../imports/types.ts';

/**
 * Reads the old WooCommerce site (its public Store API and sitemaps) for "Move from old site":
 * 1. categories, created here with the same addresses (slugs) and tree;
 * 2. every public address (sitemaps, product and category links), for the old-site check;
 * 3. every product, into an import (preview): its Start copies them with the same addresses.
 * Gentle on the old site: one request at a time, with short pauses. Safe to run again.
 */

const PER_PAGE = 100;
const PAUSE = 400;
const MAX_JSON = 25 * 1024 * 1024;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const name = (v: unknown) => (typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim() : '');

/** One page of the old site's Store API. */
async function page(url: string): Promise<{ data: unknown }> {
  const res = await fetchPublic(url, { maxBytes: MAX_JSON, timeoutMs: 90_000, accept: 'application/json' });
  return { data: JSON.parse(res.body.toString('utf8')) };
}

const update = (runId: number, values: Partial<typeof oldSiteRuns.$inferInsert>) => db.update(oldSiteRuns).set(values).where(eq(oldSiteRuns.id, runId));

/** "/product/x/" → product, "/product-category/a/b/" → category, the rest by place. */
function kindOf(path: string): OldUrlKind {
  if (path.startsWith('/product/')) return 'product';
  if (path.startsWith('/product-category/')) return 'category';
  if (path === '/' || /^\/[^/]+\/$/.test(path)) return 'page';
  return 'other';
}

async function saveAddresses(rows: { path: string; kind?: OldUrlKind; name?: string | null; oldId?: number | null }[]) {
  // One line per address (sitemaps list some pages twice).
  const byPath = new Map<string, { path: string; kind: OldUrlKind; name: string | null; oldId: number | null }>();
  for (const r of rows) {
    const path = cleanPath(r.path);
    if (path) byPath.set(path, { path, kind: r.kind ?? kindOf(path), name: r.name ?? byPath.get(path)?.name ?? null, oldId: r.oldId ?? byPath.get(path)?.oldId ?? null });
  }
  const clean = [...byPath.values()];
  for (let i = 0; i < clean.length; i += 500) {
    await db
      .insert(oldSiteUrls)
      .values(clean.slice(i, i + 500))
      .onConflictDoUpdate({ target: oldSiteUrls.path, set: { name: sql`coalesce(excluded.name, ${oldSiteUrls.name})`, oldId: sql`coalesce(excluded.old_id, ${oldSiteUrls.oldId})`, updatedAt: new Date() } });
  }
  return clean.length;
}

// ---- 1. Categories ----

interface OldCategory {
  id: number;
  name: string;
  slug: string;
  parent: number;
  description: string | null;
  link: string | null;
}

async function readCategories(site: string) {
  const all: OldCategory[] = [];
  for (let p = 1; p <= 30; p++) {
    const { data } = await page(`${site}/wp-json/wc/store/v1/products/categories?per_page=${PER_PAGE}&page=${p}`);
    const rows = list(data).filter(isObject);
    for (const c of rows) {
      const slug = typeof c.slug === 'string' ? c.slug.toLowerCase() : '';
      if (!slug || slug === 'uncategorized') continue;
      all.push({ id: Number(c.id), name: name(c.name) || slug, slug, parent: Number(c.parent) || 0, description: name(c.description) || null, link: typeof c.permalink === 'string' ? c.permalink : typeof c.link === 'string' ? c.link : null });
    }
    if (rows.length < PER_PAGE) break;
    await sleep(PAUSE);
  }
  return all;
}

/**
 * Creates the old categories here with the same slugs and tree (existing slugs are kept as they are).
 * Returns each old category id's name path ("Art Supplies > Watercolors"), for the products.
 */
async function copyCategories(old: OldCategory[], only: Set<number> | null) {
  const existing = await db.select({ id: categories.id, slug: categories.slug }).from(categories);
  const idBySlug = new Map(existing.map((c) => [c.slug, c.id]));
  const newId = new Map<number, number>();
  const byOld = new Map(old.map((c) => [c.id, c]));
  const pathOf = (id: number, seen = new Set<number>()): string[] => {
    const c = byOld.get(id);
    if (!c || seen.has(id)) return [];
    seen.add(id);
    return [...pathOf(c.parent, seen), c.name];
  };
  // Parents first.
  const depth = (c: OldCategory) => pathOf(c.id).length;
  let made = 0;
  // A test run: only the categories its products use, with their parents.
  const wanted = new Set<number>();
  for (const id of only ?? old.map((c) => c.id)) for (let at: number | undefined = id; at && !wanted.has(at); at = byOld.get(at)?.parent) wanted.add(at);
  for (const c of [...old].filter((x) => wanted.has(x.id)).sort((a, b) => depth(a) - depth(b))) {
    const parentId = c.parent ? (newId.get(c.parent) ?? null) : null;
    let id = idBySlug.get(c.slug);
    if (id === undefined) {
      const [{ next } = { next: 0 }] = await db
        .select({ next: sql<number>`coalesce(max(${categories.sortOrder}) + 1, 0)`.mapWith(Number) })
        .from(categories)
        .where(parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, parentId));
      const [row] = await db
        .insert(categories)
        .values({ name: c.name.slice(0, 100), slug: c.slug, parentId, sortOrder: next, description: c.description })
        .returning({ id: categories.id });
      id = row!.id;
      idBySlug.set(c.slug, id);
      made++;
    }
    newId.set(c.id, id);
  }
  return { made, pathOf };
}

// ---- 2. Addresses from the sitemaps ----

async function readSitemaps(site: string) {
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeEntities(m[1]!));
  const index = (await fetchPublic(`${site}/sitemap_index.xml`, { maxBytes: 5_000_000, timeoutMs: 60_000 }).catch(() => null))?.body.toString('utf8') ?? '';
  const maps = locs(index).filter((u) => u.endsWith('.xml'));
  const pages: string[] = [];
  for (const map of maps.slice(0, 50)) {
    const xml = (await fetchPublic(map, { maxBytes: 20_000_000, timeoutMs: 60_000 }).catch(() => null))?.body.toString('utf8') ?? '';
    pages.push(...locs(xml).filter((u) => !/\/wp-content\//.test(u)));
    await sleep(PAUSE);
  }
  return pages;
}

// ---- 3. Products ----

/** A Store API product as an import row, keeping its slug (its address). */
async function toImport(p: Json, site: string, pathOf: (id: number) => string[]): Promise<ImportProduct> {
  const found = await fromWooStore(p, `${site}/wp-json/wc/store/v1/products`, site);
  const slug = typeof p.slug === 'string' ? p.slug.toLowerCase() : null;
  const inStock = p.is_in_stock !== false;
  const sku = typeof p.sku === 'string' && p.sku.trim() ? p.sku.trim().slice(0, 64) : null;
  const variant = (values: string[], price: number | null, salePrice: number | null, image: string | null, i: number): ImportVariant => ({
    line: i + 1,
    values,
    sku: values.length ? null : sku,
    price,
    salePrice: salePrice !== null && price !== null && salePrice < price ? salePrice : null,
    saleStartsAt: null,
    saleEndsAt: null,
    wholesalePrice: null,
    costPrice: null,
    weightGrams: null,
    // The old site only says "in stock" or not: in stock sells freely until real counts are entered.
    stock: inStock ? null : 0,
    lowStock: null,
    allowBackorder: false,
    image,
  });
  const variants = found.variants?.length
    ? found.variants.map((v, i) => variant(v.values, v.price, v.salePrice, v.image, i))
    : [variant([], found.price ?? null, found.salePrice ?? null, null, 0)];
  const cats = list(p.categories)
    .filter(isObject)
    .map((c) => pathOf(Number(c.id)))
    .filter((path) => path.length > 0 && path.length <= 3);
  const problems: string[] = [];
  if (!found.name) problems.push('No name on the old site');
  if (variants.some((v) => v.price === null)) problems.push('No price on the old site');
  return {
    lines: [Number(p.id) || 0],
    name: (found.name ?? slug ?? 'Product').slice(0, 200),
    status: 'active',
    shortDescription: found.shortDescription ?? null,
    description: found.description ?? null,
    brand: found.brand ?? null,
    categories: cats,
    tags: found.tags ?? [],
    images: (found.images ?? []).slice(0, 12),
    specs: found.specs ?? [],
    options: found.variants?.length ? (found.options ?? []) : [],
    variants,
    seoTitle: null,
    seoDescription: null,
    slug,
    problems,
  };
}

/** The background job: reads everything, then leaves an import ready to start. */
export async function readOldSite(runId: number) {
  const [run] = await db.select().from(oldSiteRuns).where(eq(oldSiteRuns.id, runId));
  if (!run || run.status !== 'reading') return;
  const site = run.site.replace(/\/$/, '');
  try {
    await update(runId, { step: 'Reading categories' });
    const oldCats = await readCategories(site);
    const byOld = new Map(oldCats.map((c) => [c.id, c]));
    const pathOf = (id: number, seen = new Set<number>()): string[] => {
      const c = byOld.get(id);
      if (!c || seen.has(id)) return [];
      seen.add(id);
      return [...pathOf(c.parent, seen), c.name];
    };
    await saveAddresses(oldCats.flatMap((c) => (c.link ? [{ path: c.link, kind: 'category' as const, name: c.name, oldId: c.id }] : [])));
    await update(runId, { categories: oldCats.length, step: `${oldCats.length} categories read` });

    await update(runId, { step: 'Reading the sitemaps' });
    const pages = await readSitemaps(site);
    await saveAddresses(pages.map((u) => ({ path: u })));

    const items: ImportProduct[] = [];
    const usedCategories = new Set<number>();
    const limit = run.productLimit ?? Infinity;
    for (let p = 1; items.length < limit && p <= 200; p++) {
      await update(runId, { step: `Reading products (page ${p})` });
      const per = Math.min(PER_PAGE, limit - items.length);
      const { data } = await page(`${site}/wp-json/wc/store/v1/products?per_page=${per}&page=${p}&orderby=id&order=asc`);
      const rows = list(data).filter(isObject);
      for (const row of rows) {
        try {
          for (const c of list(row.categories).filter(isObject)) usedCategories.add(Number(c.id));
          items.push(await toImport(row, site, pathOf));
        } catch (err) {
          logger.warn({ err, id: row.id }, 'Old site product could not be read');
        }
      }
      await saveAddresses(rows.flatMap((r) => (typeof r.permalink === 'string' ? [{ path: r.permalink, kind: 'product' as const, name: name(r.name), oldId: Number(r.id) || null }] : [])));
      await update(runId, { productsRead: items.length, productsTotal: Math.max(items.length, run.productLimit ?? 0) });
      if (rows.length < per) break;
      await sleep(PAUSE);
    }

    await update(runId, { step: 'Making the categories' });
    const { made } = await copyCategories(oldCats, run.productLimit ? usedCategories : null);
    await update(runId, { step: `Checking the products (${made} new categories)` });
    const prepared = await prepareImport(items, { existing: 'skip', status: 'file', createMissing: true });
    const jobId = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobs)
        .values({ fileName: `Old site ${new URL(site).hostname}${run.productLimit ? ` (first ${run.productLimit})` : ''}`, format: 'old-site', options: { existing: 'skip', status: 'file', createMissing: true }, total: prepared.length, createdBy: run.createdBy })
        .returning({ id: importJobs.id });
      for (let i = 0; i < prepared.length; i += 500) {
        await tx.insert(importRows).values(
          prepared.slice(i, i + 500).map((r, n) => ({ jobId: job!.id, position: i + n, lines: r.product.lines, name: r.product.name.slice(0, 300), action: r.action, message: r.message, data: r.product })),
        );
      }
      return job!.id;
    });
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(oldSiteUrls);
    await update(runId, { status: 'ready', step: 'Ready: start the import to copy the products', importJobId: jobId, addresses: n, productsTotal: items.length, finishedAt: new Date() });
  } catch (err) {
    logger.error({ err, runId }, 'Reading the old site failed');
    await update(runId, { status: 'failed', step: null, error: (err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : 'Reading the old site failed').slice(0, 500), finishedAt: new Date() });
  }
}

