import { Router } from 'express';
import { asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db/client.ts';
import { adminUsers, customRequestFiles, customRequests, quotations } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { storage } from '../../../lib/storage.ts';
import { quoteNumber, shownStatus } from '../../quotations/service.ts';
import { kindName, requestNumber } from '../../store/custom-requests.ts';

/** "Custom order" requests from the website. Mounted behind requireAdmin + requireModule('leads'). */
export const customRequestsAdminRouter = Router();

const PAGE_SIZE = 50;
export const customRequestListQuery = z.object({
  status: z.enum(['new', 'quoted', 'closed', 'all']).default('new'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export const customRequestUpdate = z
  .object({
    status: z.enum(['new', 'quoted', 'closed']),
    staffNote: z.string().trim().max(1000).transform((s) => s || null).nullable().default(null),
  })
  .meta({ id: 'CustomRequestUpdate' });

/** The request's files (with a link for staff) and the quotations made for it. */
async function extras(ids: number[]) {
  if (!ids.length) return { files: new Map(), quotes: new Map() };
  const [files, quotes] = await Promise.all([
    db.select().from(customRequestFiles).where(inArray(customRequestFiles.requestId, ids)).orderBy(asc(customRequestFiles.id)),
    db
      .select({ id: quotations.id, number: quotations.number, status: quotations.status, validUntil: quotations.validUntil, subtotal: quotations.subtotal, requestId: quotations.customRequestId })
      .from(quotations)
      .where(inArray(quotations.customRequestId, ids))
      .orderBy(desc(quotations.id)),
  ]);
  const byRequest = <T extends { requestId: number | null }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.requestId!, [...(m.get(r.requestId!) ?? []), r]);
    return m;
  };
  return {
    files: byRequest(files.map((f) => ({ requestId: f.requestId, id: f.id, fileName: f.fileName, contentType: f.contentType, size: f.size, url: storage.url(f.storageKey) }))),
    quotes: byRequest(quotes.map((q) => ({ requestId: q.requestId, id: q.id, number: quoteNumber(q.number), status: shownStatus(q), subtotal: q.subtotal }))),
  };
}

const select = () =>
  db
    .select({ r: customRequests, handledByName: adminUsers.name })
    .from(customRequests)
    .leftJoin(adminUsers, eq(adminUsers.id, customRequests.handledBy));

const view = (row: { r: typeof customRequests.$inferSelect; handledByName: string | null }, x: Awaited<ReturnType<typeof extras>>) => ({
  ...row.r,
  number: requestNumber(row.r.number),
  kindName: kindName(row.r.kind),
  handledByName: row.handledByName,
  files: (x.files.get(row.r.id) ?? []).map(({ requestId: _r, ...f }: { requestId: number }) => f),
  quotations: (x.quotes.get(row.r.id) ?? []).map(({ requestId: _r, ...q }: { requestId: number }) => q),
});

customRequestsAdminRouter.get('/', async (req, res) => {
  const q = customRequestListQuery.parse(req.query);
  const where = q.status === 'all' ? undefined : eq(customRequests.status, q.status);
  const [rows, [total], counted] = await Promise.all([
    select()
      .where(where)
      // New ones: oldest first (waiting longest). Others: latest first.
      .orderBy(q.status === 'new' ? sql`${customRequests.createdAt} asc` : desc(customRequests.updatedAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(customRequests).where(where),
    db.select({ status: customRequests.status, n: count() }).from(customRequests).groupBy(customRequests.status),
  ]);
  const x = await extras(rows.map((r) => r.r.id));
  const by = Object.fromEntries(counted.map((c) => [c.status, c.n]));
  res.json({
    items: rows.map((r) => view(r, x)),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: PAGE_SIZE,
    counts: { new: by.new ?? 0, quoted: by.quoted ?? 0, closed: by.closed ?? 0 },
  });
});

customRequestsAdminRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [row] = await select().where(eq(customRequests.id, id));
  if (!row) throw notFound('Request not found');
  res.json(view(row, await extras([id])));
});

customRequestsAdminRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = customRequestUpdate.parse(req.body);
  const [before] = await db.select().from(customRequests).where(eq(customRequests.id, id));
  if (!before) throw notFound('Request not found');
  const handled = input.status !== 'new';
  await db
    .update(customRequests)
    .set({
      status: input.status,
      staffNote: input.staffNote,
      handledBy: handled ? (before.handledBy ?? req.admin!.id) : null,
      handledAt: handled ? (before.handledAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(eq(customRequests.id, id));
  await audit(req, { action: 'custom_request.update', entityType: 'custom_request', entityId: id, before: { status: before.status }, after: input });
  const [row] = await select().where(eq(customRequests.id, id));
  res.json(view(row!, await extras([id])));
});
