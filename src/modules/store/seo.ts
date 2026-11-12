import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { brands, notFoundLog, products, redirects } from '../../db/schema/index.ts';
import { cleanPath } from '../../lib/paths.ts';
import { activeCategories } from './catalog.ts';

/** Redirects, the "not found" log and the sitemap, for the website server. Mounted at /v1/store. */
export const storeSeoRouter = Router();

/**
 * All redirects, for the website to keep in memory (it checks every visit against them, without
 * asking here each time). Small: one line per old address.
 */
storeSeoRouter.get('/redirects', async (_req, res) => {
  const rows = await db.select({ from: redirects.fromPath, to: redirects.toPath, code: redirects.code }).from(redirects);
  res.set('cache-control', 'public, max-age=30').json({ items: rows.map((r) => [r.from, r.to, r.code]) });
});

/** Junk that every website gets (attack scanners): not worth a line in the log. */
const NOISE = /(\.(php|asp|aspx|jsp|cgi|env|ini|bak|sql|git|ds_store)$)|^\/(wp-admin|wp-includes|wp-login|xmlrpc|cgi-bin|\.well-known|\.git|vendor|admin|phpmyadmin)\b/;

const seen = z.object({
  /** Redirects used since the last report: { "/old/": 3 }. */
  hits: z.record(z.string().max(500), z.number().int().min(1).max(10_000)).default({}),
  /** Addresses that ended on "not found". */
  notFound: z.array(z.object({ path: z.string().max(500), referrer: z.string().max(500).nullable().default(null), count: z.number().int().min(1).max(10_000).default(1) })).max(200).default([]),
});

// The website server reports every half minute; a lot more than that is someone filling the log.
const reportLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
/** Never more than this many lines in the log: the rarest old ones make room. */
const MAX_LOG = 20_000;

/** What visitors met: used redirects, and addresses that do not exist (for staff to fix). */
storeSeoRouter.post('/seen', reportLimiter, async (req, res) => {
  const input = seen.parse(req.body);
  const now = new Date();
  for (const [raw, n] of Object.entries(input.hits).slice(0, 500)) {
    const path = cleanPath(raw);
    if (path) await db.update(redirects).set({ hits: sql`${redirects.hits} + ${n}`, lastHitAt: now }).where(eq(redirects.fromPath, path));
  }
  for (const nf of input.notFound) {
    const path = cleanPath(nf.path);
    // The website's own error pages are not missing addresses.
    if (!path || NOISE.test(path) || /^\/(404|500)\/$/.test(path)) continue;
    await db
      .insert(notFoundLog)
      .values({ path, referrer: nf.referrer, hits: nf.count, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: notFoundLog.path,
        set: { hits: sql`${notFoundLog.hits} + ${nf.count}`, lastSeenAt: now, referrer: sql`coalesce(excluded.referrer, ${notFoundLog.referrer})` },
      });
  }
  if (input.notFound.length) {
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(notFoundLog);
    if (n > MAX_LOG) {
      await db.execute(sql`delete from not_found_log where id in (select id from not_found_log order by hits asc, last_seen_at asc limit ${n - MAX_LOG})`);
    }
  }
  res.status(204).end();
});

/** Everything Google should know about: products, categories (with products), brands. */
storeSeoRouter.get('/sitemap', async (_req, res) => {
  const [rows, cats, brandRows] = await Promise.all([
    db.select({ slug: products.slug, updatedAt: products.updatedAt }).from(products).where(eq(products.status, 'active')).orderBy(asc(products.id)),
    activeCategories(),
    db.select({ slug: brands.slug, updatedAt: brands.updatedAt }).from(brands).where(and(eq(brands.isActive, true))),
  ]);
  const pathOf = (id: number): string[] => {
    const c = cats.all.find((x) => x.id === id);
    return c ? [...(c.parentId ? pathOf(c.parentId) : []), c.slug] : [];
  };
  res.set('cache-control', 'public, max-age=600').json({
    products: rows.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt })),
    categories: cats.all.filter((c) => cats.count(c.id) > 0).map((c) => ({ path: pathOf(c.id).join('/') })),
    brands: brandRows.map((b) => ({ slug: b.slug, updatedAt: b.updatedAt })),
  });
});
