import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { importJobs, oldSiteRuns } from '../../../db/schema/index.ts';
import { QUEUES, sendJob } from '../../../jobs/boss.ts';
import { audit } from '../../../lib/audit.ts';
import { conflict } from '../../../lib/errors.ts';
import { FetchError, fetchPublic } from '../../../lib/safe-fetch.ts';
import { badRequest } from '../../../lib/errors.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { addressReport, applySuggestions, suggestMatches } from './check.ts';

/** "Move from old site". Mounted behind requireAdmin + requireSuperAdmin. */
export const migrationRouter = Router();

const runOf = async () => {
  const [run] = await db.select().from(oldSiteRuns).orderBy(desc(oldSiteRuns.id)).limit(1);
  if (!run) return null;
  const [job] = run.importJobId ? await db.select().from(importJobs).where(eq(importJobs.id, run.importJobId)) : [];
  return { ...run, importJob: job ? { id: job.id, status: job.status, total: job.total, processed: job.processed, created: job.created, skipped: job.skipped, failed: job.failed } : null };
};

/** The last run (reading progress, and its import). */
migrationRouter.get('/', async (_req, res) => {
  res.json({ run: await runOf() });
});

/** Starts reading the old site in the background. `limit`: only the first N products (a test). */
migrationRouter.post('/read', async (req, res) => {
  const input = z
    .object({
      site: z.string().trim().url({ error: 'Enter the old site address, like https://papertree.com.bd' }).default('https://papertree.com.bd'),
      limit: z.number().int().min(1).max(100_000).nullable().default(null),
    })
    .parse(req.body ?? {});
  const last = await runOf();
  if (last?.status === 'reading') throw conflict('The old site is being read already');
  const site = new URL(input.site).origin;
  // A quick look first: is it a WooCommerce shop we can read?
  try {
    await fetchPublic(`${site}/wp-json/wc/store/v1/products?per_page=1`, { maxBytes: 2_000_000, timeoutMs: 60_000, accept: 'application/json' });
  } catch (err) {
    throw badRequest(err instanceof FetchError ? `Could not read the old site: ${err.message}` : 'Could not read the old site', { site: 'Could not read this site' });
  }
  const [run] = await db.insert(oldSiteRuns).values({ site, productLimit: input.limit, createdBy: currentAdmin(req).id, step: 'Waiting to start' }).returning();
  await sendJob(QUEUES.oldSiteRead, { runId: run!.id });
  await audit(req, { action: 'old-site.read', entityType: 'old-site', entityId: run!.id, after: { site, limit: input.limit } });
  res.status(201).json({ run: await runOf() });
});

const reportQuery = z.object({
  state: z.enum(['ok', 'redirected', 'hidden', 'missing']).optional(),
  kind: z.enum(['product', 'category', 'page', 'other']).optional(),
  page: z.coerce.number().int().min(1).catch(1),
});

/** Every old address and its state here. */
migrationRouter.get('/addresses', async (req, res) => {
  const q = reportQuery.parse(req.query);
  res.json(await addressReport({ ...q, pageSize: 50 }));
});

/** Looks for matches for missing addresses (a batch at a time; call again while `left` > 0). */
migrationRouter.post('/suggest', async (req, res) => {
  res.json(await suggestMatches(150, req.body?.again === true));
});

/** Makes redirects from the suggestions: these ids, or all. */
migrationRouter.post('/apply', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(5000).nullable().default(null) }).parse(req.body ?? {});
  const result = await applySuggestions(ids, currentAdmin(req).id);
  await audit(req, { action: 'old-site.apply', entityType: 'old-site', after: { made: result.made, problems: result.problems.length } });
  res.json(result);
});
