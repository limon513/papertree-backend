import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { products } from './products.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

/**
 * preview: file checked, waiting for "Start import".
 * queued/running: being imported in the background.
 * done / failed / cancelled: finished.
 */
export type ImportStatus = 'preview' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type ImportFormat = 'papertree' | 'woocommerce' | 'daraz' | 'link' | 'old-site';

export interface ImportOptions {
  /** What to do when a product's SKU already exists. */
  existing: 'skip' | 'update';
  /** Status for new products: as in the file, or always draft. */
  status: 'file' | 'draft';
  /** Create categories and brands that don't exist yet. */
  createMissing: boolean;
}

export const importJobs = pgTable(
  'import_jobs',
  {
    id: id(),
    status: text('status').$type<ImportStatus>().notNull().default('preview'),
    fileName: text('file_name').notNull(),
    format: text('format').$type<ImportFormat>().notNull(),
    options: jsonb('options').$type<ImportOptions>().notNull(),
    /** Products in the file (one product can be several rows). */
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** Why the whole import stopped, if it did. */
    error: text('error'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    ...timestamps,
  },
  (t) => [index('import_jobs_created_at_idx').on(t.createdAt)],
);

export type ImportAction = 'create' | 'update' | 'skip' | 'error';
export type ImportRowStatus = 'pending' | 'done' | 'skipped' | 'failed';

/** One product from the file. */
export const importRows = pgTable(
  'import_rows',
  {
    id: id(),
    jobId: ref('job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** Line numbers in the file (a product with variants spans several lines). */
    lines: integer('lines').array().notNull(),
    name: text('name').notNull(),
    /** What the preview decided. */
    action: text('action').$type<ImportAction>().notNull(),
    status: text('status').$type<ImportRowStatus>().notNull().default('pending'),
    /** Problem or note shown to the user. */
    message: text('message'),
    /** The product as read from the file (see imports/types.ts). */
    data: jsonb('data').notNull(),
    productId: ref('product_id').references(() => products.id, { onDelete: 'set null' }),
  },
  (t) => [index('import_rows_job_id_idx').on(t.jobId, t.position)],
);
