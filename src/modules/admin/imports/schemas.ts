import { z } from 'zod';

export const MAX_CSV_MB = 20;

/** Options sent with the file (multipart form fields are text). */
export const importOptionsBody = z.object({
  existing: z.enum(['skip', 'update']).default('skip').meta({
    description: 'When a SKU is already in the shop: skip that product, or update its prices and stock',
  }),
  status: z.enum(['file', 'draft']).default('file').meta({
    description: 'Status of new products: as in the file, or always draft (to check them first)',
  }),
  createMissing: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true')
    .meta({ description: 'Create categories and brands that do not exist yet' }),
});

export const ROW_FILTERS = ['all', 'create', 'update', 'skip', 'error', 'failed'] as const;

export const importRowsQuery = z.object({
  filter: z.enum(ROW_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).default(1),
});

// ---- Responses (used for docs) ----

const counts = z.object({ create: z.number(), update: z.number(), skip: z.number(), error: z.number() });

export const importJobSchema = z
  .object({
    id: z.number(),
    status: z.enum(['preview', 'queued', 'running', 'done', 'failed', 'cancelled']),
    fileName: z.string(),
    format: z.enum(['papertree', 'woocommerce']),
    options: z.object({ existing: z.enum(['skip', 'update']), status: z.enum(['file', 'draft']), createMissing: z.boolean() }),
    total: z.number(),
    processed: z.number(),
    created: z.number(),
    updated: z.number(),
    skipped: z.number(),
    failed: z.number(),
    error: z.string().nullable(),
    createdBy: z.object({ id: z.number(), name: z.string() }).nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    preview: counts.meta({ description: 'What the check decided, per product' }),
  })
  .meta({ id: 'ImportJob' });

export const importRowSchema = z.object({
  id: z.number(),
  position: z.number(),
  lines: z.array(z.number()),
  name: z.string(),
  action: z.enum(['create', 'update', 'skip', 'error']),
  status: z.enum(['pending', 'done', 'skipped', 'failed']),
  message: z.string().nullable(),
  productId: z.number().nullable(),
  variants: z.number(),
  images: z.number(),
  price: z.number().nullable(),
});

export const importDetail = z
  .object({ job: importJobSchema, rows: z.array(importRowSchema), rowsTotal: z.number(), page: z.number(), pageSize: z.number() })
  .meta({ id: 'ImportDetail' });

export const importList = z.object({ items: z.array(importJobSchema) }).meta({ id: 'ImportList' });
