import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { categories, oldSiteUrls, products, redirects, type OldUrlKind } from '../../../db/schema/index.ts';
import { planSearch, searchRank, searchWhere } from '../../store/search.ts';
import { saveRedirect } from '../seo/service.ts';

/**
 * The old-site check: does each old address still lead somewhere on the new shop?
 * ok: the same address works here. redirected: it sends people on. hidden: the product or category
 * is here but not published (its address shows "not found"). missing: nothing yet.
 */
export type AddressState = 'ok' | 'redirected' | 'hidden' | 'missing';

/** The new shop's own pages. */
const SHOP_PAGES = new Set(['/', '/shop/', '/cart/', '/checkout/', '/brands/', '/deals/', '/new/', '/search/', '/categories/', '/account/']);

/** WordPress / WooCommerce pages and their place here. '' = gone for good (410). */
const PAGE_MAP: Record<string, string> = {
  '/home/': '/',
  '/my-account/': '/account/',
  '/wishlist/': '/account/',
  '/compare/': '/shop/',
  '/order-tracking/': '/account/',
  '/product-request/': '/search/',
  '/blog/': '/',
  '/sale-with-us/': '/',
  '/sample-page/': '',
};
/** Theme demo pages the old site had (never real content). */
const GONE = /^\/(portfolio|order_status)\//;

const lastPart = (path: string) => path.split('/').filter(Boolean).pop() ?? '';

async function lookups() {
  const [prods, cats, reds] = await Promise.all([
    db.select({ slug: products.slug, status: products.status }).from(products),
    db.select({ id: categories.id, slug: categories.slug, name: categories.name, parentId: categories.parentId, isActive: categories.isActive }).from(categories),
    db.select({ fromPath: redirects.fromPath, toPath: redirects.toPath, code: redirects.code }).from(redirects),
  ]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const catPath = (id: number): string[] => {
    const c = catById.get(id);
    return c ? [...(c.parentId ? catPath(c.parentId) : []), c.slug] : [];
  };
  return {
    product: new Map(prods.map((p) => [p.slug, p.status])),
    category: new Map(cats.map((c) => [c.slug, c])),
    catPath,
    cats,
    redirect: new Map(reds.map((r) => [r.fromPath, r])),
  };
}

function stateOf(row: { path: string; kind: OldUrlKind }, l: Awaited<ReturnType<typeof lookups>>): { state: AddressState; to: string | null } {
  const r = l.redirect.get(row.path);
  if (r) return { state: 'redirected', to: r.code === 410 ? '' : r.toPath };
  if (row.kind === 'product') {
    const status = l.product.get(lastPart(row.path));
    return { state: status === 'active' ? 'ok' : status ? 'hidden' : 'missing', to: null };
  }
  if (row.kind === 'category') {
    const c = l.category.get(lastPart(row.path));
    return { state: c ? (c.isActive ? 'ok' : 'hidden') : 'missing', to: null };
  }
  return { state: SHOP_PAGES.has(row.path) ? 'ok' : 'missing', to: null };
}

/** Every old address with its state now, and counts per state and kind. */
export async function addressReport(filter: { state?: AddressState; kind?: OldUrlKind; page: number; pageSize: number }) {
  const [rows, l] = await Promise.all([db.select().from(oldSiteUrls).orderBy(asc(oldSiteUrls.kind), asc(oldSiteUrls.path)), lookups()]);
  const all = rows.map((r) => ({ ...r, ...stateOf(r, l) }));
  const counts: Record<string, Record<AddressState, number>> = {};
  for (const r of all) {
    counts[r.kind] ??= { ok: 0, redirected: 0, hidden: 0, missing: 0 };
    counts[r.kind]![r.state]++;
  }
  const shown = all.filter((r) => (!filter.state || r.state === filter.state) && (!filter.kind || r.kind === filter.kind));
  return {
    counts,
    total: shown.length,
    items: shown.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize).map((r) => ({
      id: r.id,
      path: r.path,
      kind: r.kind,
      name: r.name,
      state: r.state,
      redirectsTo: r.to,
      suggestedPath: r.suggestedPath,
      suggestedName: r.suggestedName,
    })),
  };
}

/**
 * Finds a match for missing addresses that have none yet (up to `batch` at a time): a product by its
 * old name (the shop search, typos and synonyms included), a category by name, a known page. Saved,
 * for staff to look at and apply. Returns how many are still to look at.
 */
export async function suggestMatches(batch = 150, again = false) {
  // Again (after more products were copied, or the demo data was removed): forget the old guesses.
  if (again) await db.update(oldSiteUrls).set({ suggestedPath: null, suggestedName: null });
  const l = await lookups();
  const open = await db.select().from(oldSiteUrls).where(isNull(oldSiteUrls.suggestedName)).limit(2000);
  const missing = open.filter((r) => stateOf(r, l).state === 'missing').slice(0, batch);
  // Not missing (works now, or redirected): nothing to suggest; marked so they are not checked again.
  const notMissing = open.filter((r) => stateOf(r, l).state !== 'missing').map((r) => r.id);
  if (notMissing.length) await db.update(oldSiteUrls).set({ suggestedName: '' }).where(inArray(oldSiteUrls.id, notMissing));

  for (const r of missing) {
    let path: string | null = null;
    let label = '';
    if (r.kind === 'product' && r.name) {
      const plan = await planSearch(r.name);
      if (plan) {
        const [best] = await db
          .select({ slug: products.slug, name: products.name })
          .from(products)
          .where(and(eq(products.status, 'active'), searchWhere(plan)))
          .orderBy(searchRank(plan))
          .limit(1);
        if (best) [path, label] = [`/product/${best.slug}/`, best.name];
      }
    } else if (r.kind === 'category') {
      const wanted = (r.name ?? lastPart(r.path).replace(/-/g, ' ')).toLowerCase();
      const c = l.cats.find((x) => x.isActive && x.name.toLowerCase() === wanted);
      if (c) [path, label] = [`/product-category/${l.catPath(c.id).join('/')}/`, c.name];
    } else if (GONE.test(r.path) || /^\/(portfolio|order_status)\/$/.test(r.path)) {
      [path, label] = ['', 'Gone (theme demo page)'];
    } else if (r.path in PAGE_MAP) {
      path = PAGE_MAP[r.path]!;
      label = path ? `Shop page ${path}` : 'Gone';
    }
    await db
      .update(oldSiteUrls)
      .set({ suggestedPath: path, suggestedName: label || '—', updatedAt: new Date() })
      .where(eq(oldSiteUrls.id, r.id));
  }
  const left = open.length - notMissing.length - missing.length;
  return { looked: missing.length, left: Math.max(0, left) };
}

/** Makes redirects from the suggestions (these ids, or every missing address with one). */
export async function applySuggestions(ids: number[] | null, adminUserId: number) {
  const l = await lookups();
  const rows = await db
    .select()
    .from(oldSiteUrls)
    .where(and(sql`${oldSiteUrls.suggestedPath} is not null`, ids ? inArray(oldSiteUrls.id, ids) : undefined));
  let made = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (stateOf(r, l).state !== 'missing') continue;
    try {
      await saveRedirect(db, { from: r.path, to: r.suggestedPath!, code: r.suggestedPath === '' ? 410 : 301, source: 'old-site', adminUserId });
      made++;
    } catch (err) {
      problems.push(`${r.path}: ${err instanceof Error ? err.message : 'could not save'}`);
    }
  }
  return { made, problems: problems.slice(0, 50) };
}
