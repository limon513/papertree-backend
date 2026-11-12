import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { importJobs } from './imports.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

export type RedirectSource = 'manual' | 'auto' | 'old-site';

/**
 * Old addresses that now live elsewhere: the website answers /old-path/ with a permanent redirect
 * (301) to the new one, or 410 "gone for good" when there is nothing to send people to. Paths are
 * kept tidy (lower case, a trailing slash, no ?query) by lib/paths.ts.
 */
export const redirects = pgTable(
  'redirects',
  {
    id: id(),
    fromPath: text('from_path').notNull().unique(),
    /** A path on this website ("/product/new-name/"). Empty for 410. */
    toPath: text('to_path').notNull(),
    /** 301: moved for good (Google moves the ranking); 302: for now; 410: gone, nothing to show. */
    code: integer('code').notNull().default(301),
    /** manual: staff added it; auto: a product, category or brand address was changed; old-site: from the old site check. */
    source: text('source').$type<RedirectSource>().notNull().default('manual'),
    note: text('note'),
    hits: integer('hits').notNull().default(0),
    lastHitAt: timestamptz('last_hit_at'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('redirects_to_path_idx').on(t.toPath)],
);

/** Addresses visitors (or Google) asked for that do not exist: to fix with a redirect. */
export const notFoundLog = pgTable(
  'not_found_log',
  {
    id: id(),
    path: text('path').notNull().unique(),
    hits: integer('hits').notNull().default(1),
    /** The page that linked to it (another site, Google, our own page). */
    referrer: text('referrer'),
    /** Staff looked at it and decided it needs nothing. */
    ignored: boolean('ignored').notNull().default(false),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('not_found_log_last_seen_idx').on(t.lastSeenAt)],
);

export type OldUrlKind = 'product' | 'category' | 'page' | 'other';

/**
 * The old website's addresses (its sitemap, product feed and menus), loaded once and checked against
 * the new shop: does each one still lead somewhere?
 */
export const oldSiteUrls = pgTable(
  'old_site_urls',
  {
    id: id(),
    path: text('path').notNull().unique(),
    kind: text('kind').$type<OldUrlKind>().notNull(),
    /** Product or category name on the old site, to find its match here. */
    name: text('name'),
    /** WordPress id (old short links like /?p=123). */
    oldId: integer('old_id'),
    /** Best guess for where it should go, worked out when loaded (staff confirm it). */
    suggestedPath: text('suggested_path'),
    suggestedName: text('suggested_name'),
    ...timestamps,
  },
  (t) => [index('old_site_urls_kind_idx').on(t.kind)],
);

export type OldSiteRunStatus = 'reading' | 'ready' | 'failed';

/**
 * Reading the old website (Super Admin, "Move from old site"): its addresses, categories and
 * products. The products land in an import (preview first); its Start copies them, with the same
 * addresses. A run can be repeated: what is already here is skipped.
 */
export const oldSiteRuns = pgTable('old_site_runs', {
  id: id(),
  /** "https://papertree.com.bd". */
  site: text('site').notNull(),
  status: text('status').$type<OldSiteRunStatus>().notNull().default('reading'),
  /** What it is doing now, for the progress line. */
  step: text('step'),
  /** For a test: read only this many products. null: all. */
  productLimit: integer('product_limit'),
  productsTotal: integer('products_total').notNull().default(0),
  productsRead: integer('products_read').notNull().default(0),
  categories: integer('categories').notNull().default(0),
  addresses: integer('addresses').notNull().default(0),
  importJobId: ref('import_job_id').references(() => importJobs.id, { onDelete: 'set null' }),
  error: text('error'),
  createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  startedAt: timestamptz('started_at').notNull().defaultNow(),
  finishedAt: timestamptz('finished_at'),
});
