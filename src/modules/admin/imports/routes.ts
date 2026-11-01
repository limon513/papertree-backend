import { Router } from 'express';
import multer from 'multer';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, importJobs, importRows } from '../../../db/schema/index.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { audit } from '../../../lib/audit.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { QUEUES, sendJob } from '../../../jobs/boss.ts';
import { readProductCsv, templateCsv } from './csv.ts';
import { prepareImport } from './prepare.ts';
import { importOptionsBody, importRowsQuery, MAX_CSV_MB } from './schemas.ts';

/** Mounted behind requireAdmin + requireModule('imports'). */
export const importsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    if (/\.xlsx?$/i.test(file.originalname)) {
      return done(badRequest('Excel files are not supported', { file: 'In Excel use File > Save As > CSV, then upload that file' }));
    }
    if (!/\.(csv|txt)$/i.test(file.originalname)) {
      return done(badRequest('This is not a CSV file', { file: 'Upload a .csv file' }));
    }
    done(null, true);
  },
});

type JobRow = typeof importJobs.$inferSelect;

/** Per-action counts from the check, for every job in the list. */
async function previewCounts(jobIds: number[]) {
  if (!jobIds.length) return new Map<number, Record<string, number>>();
  const rows = await db
    .select({ jobId: importRows.jobId, action: importRows.action, n: count() })
    .from(importRows)
    .where(inArray(importRows.jobId, jobIds))
    .groupBy(importRows.jobId, importRows.action);
  const result = new Map<number, Record<string, number>>();
  for (const r of rows) result.set(r.jobId, { ...(result.get(r.jobId) ?? {}), [r.action]: r.n });
  return result;
}

async function jobViews(jobs: { job: JobRow; creatorName: string | null }[]) {
  const preview = await previewCounts(jobs.map((j) => j.job.id));
  return jobs.map(({ job, creatorName }) => {
    const c = preview.get(job.id) ?? {};
    return {
      id: job.id,
      status: job.status,
      fileName: job.fileName,
      format: job.format,
      options: job.options,
      total: job.total,
      processed: job.processed,
      created: job.created,
      updated: job.updated,
      skipped: job.skipped,
      failed: job.failed,
      error: job.error,
      createdBy: job.createdBy !== null && creatorName ? { id: job.createdBy, name: creatorName } : null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
      preview: { create: c.create ?? 0, update: c.update ?? 0, skip: c.skip ?? 0, error: c.error ?? 0 },
    };
  });
}

const jobQuery = () =>
  db
    .select({ job: importJobs, creatorName: adminUsers.name })
    .from(importJobs)
    .leftJoin(adminUsers, eq(adminUsers.id, importJobs.createdBy));

async function getJob(id: number) {
  const [row] = await jobQuery().where(eq(importJobs.id, id));
  if (!row) throw notFound('Import not found');
  return (await jobViews([row]))[0]!;
}

importsRouter.get('/template.csv', (_req, res) => {
  res
    .set('content-type', 'text/csv; charset=utf-8')
    .set('content-disposition', 'attachment; filename="papertree-products-template.csv"')
    .send(`﻿${templateCsv()}`);
});

importsRouter.get('/', async (_req, res) => {
  const rows = await jobQuery().orderBy(desc(importJobs.createdAt)).limit(30);
  res.json({ items: await jobViews(rows) });
});

/** Reads and checks the file. Nothing is imported until "start". */
importsRouter.post('/products', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a CSV file', { file: 'Choose a CSV file' });
  const options = importOptionsBody.parse(req.body ?? {});
  const { format, products } = readProductCsv(req.file.buffer);
  const prepared = await prepareImport(products, options);

  const jobId = await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(importJobs)
      .values({
        fileName: req.file!.originalname.slice(0, 200),
        format,
        options,
        total: prepared.length,
        createdBy: currentAdmin(req).id,
      })
      .returning({ id: importJobs.id });
    for (let i = 0; i < prepared.length; i += 500) {
      await tx.insert(importRows).values(
        prepared.slice(i, i + 500).map((r, n) => ({
          jobId: job!.id,
          position: i + n,
          lines: r.product.lines,
          name: r.product.name.slice(0, 300),
          action: r.action,
          message: r.message,
          data: r.product,
        })),
      );
    }
    return job!.id;
  });

  await audit(req, { action: 'import.upload', entityType: 'import', entityId: jobId, after: { fileName: req.file.originalname, format, options } });
  res.status(201).json(await getJob(jobId));
});

const PAGE_SIZE = 100;

importsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const q = importRowsQuery.parse(req.query);
  const job = await getJob(id);

  const filters: Record<(typeof q)['filter'], SQL | undefined> = {
    all: undefined,
    create: eq(importRows.action, 'create'),
    update: eq(importRows.action, 'update'),
    skip: eq(importRows.action, 'skip'),
    error: eq(importRows.action, 'error'),
    failed: eq(importRows.status, 'failed'),
  };
  const where = and(eq(importRows.jobId, id), filters[q.filter]);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: importRows.id,
        position: importRows.position,
        lines: importRows.lines,
        name: importRows.name,
        action: importRows.action,
        status: importRows.status,
        message: importRows.message,
        productId: importRows.productId,
        variants: sql<number>`jsonb_array_length(${importRows.data}->'variants')`.mapWith(Number),
        images: sql<number>`jsonb_array_length(${importRows.data}->'images')`.mapWith(Number),
        price: sql<number | null>`(${importRows.data}->'variants'->0->>'price')::numeric`.mapWith((v) => (v === null ? null : Number(v))),
      })
      .from(importRows)
      .where(where)
      .orderBy(asc(importRows.position))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(importRows).where(where),
  ]);

  res.json({ job, rows, rowsTotal: total?.n ?? 0, page: q.page, pageSize: PAGE_SIZE });
});

importsRouter.post('/:id/start', async (req, res) => {
  const id = parseId(req.params.id);
  const job = await getJob(id);
  if (job.status !== 'preview') throw badRequest('This import has already been started');
  if (job.preview.create + job.preview.update === 0) throw badRequest('There is nothing to import in this file');

  await db.update(importJobs).set({ status: 'queued' }).where(and(eq(importJobs.id, id), eq(importJobs.status, 'preview')));
  await sendJob(QUEUES.productImport, { jobId: id });
  await audit(req, { action: 'import.start', entityType: 'import', entityId: id });
  res.json(await getJob(id));
});

importsRouter.post('/:id/cancel', async (req, res) => {
  const id = parseId(req.params.id);
  const job = await getJob(id);
  if (!['preview', 'queued', 'running'].includes(job.status)) throw badRequest('This import has already finished');

  await db.update(importJobs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(importJobs.id, id));
  await audit(req, { action: 'import.cancel', entityType: 'import', entityId: id });
  res.json(await getJob(id));
});

