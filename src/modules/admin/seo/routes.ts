import { Router } from 'express';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { notFoundLog, redirects } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { AppError, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { REDIRECT_CODES, saveRedirect } from './service.ts';

/** Redirects and the "not found" log. Mounted behind requireAdmin + requireModule('content'). */
export const seoRouter = Router();

const PAGE = 50;
const like = (s: string) => `%${s.replace(/[%_\\]/g, '')}%`;

export const redirectBody = z
  .object({
    fromPath: z.string().trim().min(1, { error: 'Enter the old address' }).max(600),
    toPath: z.string().trim().max(600).default(''),
    code: z.union(REDIRECT_CODES.map((c) => z.literal(c)) as [z.ZodLiteral<301>, z.ZodLiteral<302>, z.ZodLiteral<410>]).default(301),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .meta({ id: 'RedirectBody' });

export const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  source: z.enum(['manual', 'auto', 'old-site']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

// ---- Redirects ----

seoRouter.get('/redirects', async (req, res) => {
  const q = listQuery.parse(req.query);
  const where = and(q.search ? or(ilike(redirects.fromPath, like(q.search)), ilike(redirects.toPath, like(q.search))) : undefined, q.source ? eq(redirects.source, q.source) : undefined);
  const [items, [total]] = await Promise.all([
    db.select().from(redirects).where(where).orderBy(desc(redirects.updatedAt)).limit(PAGE).offset((q.page - 1) * PAGE),
    db.select({ n: count() }).from(redirects).where(where),
  ]);
  res.json({ items, total: total!.n, page: q.page, pageSize: PAGE });
});

seoRouter.post('/redirects', async (req, res) => {
  const input = redirectBody.parse(req.body);
  const row = await db.transaction((tx) => saveRedirect(tx, { from: input.fromPath, to: input.toPath, code: input.code, source: 'manual', note: input.note, adminUserId: currentAdmin(req).id }));
  await audit(req, { action: 'redirect.save', entityType: 'redirect', entityId: row.id, after: { from: row.fromPath, to: row.toPath, code: row.code } });
  res.status(201).json(row);
});

seoRouter.put('/redirects/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = redirectBody.parse(req.body);
  const [before] = await db.select().from(redirects).where(eq(redirects.id, id));
  if (!before) throw notFound('Redirect not found');
  const row = await db.transaction(async (tx) => {
    // A changed old address: the old line goes, the new one is checked like a new redirect.
    if (before.fromPath !== input.fromPath) await tx.delete(redirects).where(eq(redirects.id, id));
    return saveRedirect(tx, { from: input.fromPath, to: input.toPath, code: input.code, source: before.source, note: input.note, adminUserId: currentAdmin(req).id });
  });
  await audit(req, { action: 'redirect.save', entityType: 'redirect', entityId: row.id, before: { from: before.fromPath, to: before.toPath, code: before.code }, after: { from: row.fromPath, to: row.toPath, code: row.code } });
  res.json(row);
});

seoRouter.delete('/redirects/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await db.delete(redirects).where(eq(redirects.id, id)).returning();
  if (!row) throw notFound('Redirect not found');
  await audit(req, { action: 'redirect.delete', entityType: 'redirect', entityId: id, before: { from: row.fromPath, to: row.toPath } });
  res.status(204).end();
});

/** Many at once, one per line: "old-address, new-address" (or "old-address, 410" for gone). */
seoRouter.post('/redirects/import', async (req, res) => {
  const { lines } = z.object({ lines: z.string().max(500_000) }).parse(req.body);
  const rows = lines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (rows.length > 5000) throw new AppError(400, 'BAD_REQUEST', 'At most 5,000 lines at a time');
  const done: number[] = [];
  const problems: { line: number; text: string; message: string }[] = [];
  for (const [i, text] of rows.entries()) {
    const [from = '', to = '', code = ''] = text.split(/\s*[,\t]\s*/);
    const gone = to === '410' || code === '410';
    try {
      const row = await db.transaction((tx) => saveRedirect(tx, { from, to: gone ? '' : to, code: gone ? 410 : code === '302' ? 302 : 301, source: 'manual', adminUserId: currentAdmin(req).id }));
      done.push(row.id);
    } catch (err) {
      problems.push({ line: i + 1, text, message: err instanceof AppError ? err.message : 'Could not save' });
    }
  }
  await audit(req, { action: 'redirect.import', entityType: 'redirect', after: { saved: done.length, problems: problems.length } });
  res.json({ saved: done.length, problems: problems.slice(0, 200) });
});

// ---- Not found ----

seoRouter.get('/not-found', async (req, res) => {
  const q = z.object({ view: z.enum(['open', 'ignored']).default('open'), search: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).catch(1) }).parse(req.query);
  const where = and(eq(notFoundLog.ignored, q.view === 'ignored'), q.search ? ilike(notFoundLog.path, like(q.search)) : undefined);
  const [items, [total]] = await Promise.all([
    db.select().from(notFoundLog).where(where).orderBy(desc(notFoundLog.hits), desc(notFoundLog.lastSeenAt)).limit(PAGE).offset((q.page - 1) * PAGE),
    db.select({ n: count() }).from(notFoundLog).where(where),
  ]);
  res.json({ items, total: total!.n, page: q.page, pageSize: PAGE });
});

seoRouter.post('/not-found/:id/ignore', async (req, res) => {
  const id = parseId(req.params.id);
  const ignored = req.body?.ignored !== false;
  const [row] = await db.update(notFoundLog).set({ ignored }).where(eq(notFoundLog.id, id)).returning();
  if (!row) throw notFound('Not found');
  res.json(row);
});

/** Clears the log (it fills again with what visitors meet from now on). */
seoRouter.delete('/not-found', async (req, res) => {
  const { rowCount } = await db.execute(sql`delete from not_found_log where not ignored`);
  await audit(req, { action: 'not-found.clear', entityType: 'redirect', after: { removed: rowCount } });
  res.status(204).end();
});

/** Counts for the page tabs. */
seoRouter.get('/summary', async (_req, res) => {
  const [[r], [nf]] = await Promise.all([
    db.select({ n: count(), hits: sql<number>`coalesce(sum(${redirects.hits}), 0)::int` }).from(redirects),
    db.select({ n: count() }).from(notFoundLog).where(eq(notFoundLog.ignored, false)),
  ]);
  res.json({ redirects: r!.n, redirectHits: r!.hits, notFound: nf!.n });
});



