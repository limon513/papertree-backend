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
    format: z.enum(['papertree', 'woocommerce', 'daraz', 'link']).meta({ description: 'link: one product copied from a web page (fileName is the link)' }),
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

// ---- Import from a link ----

export const linkReadBody = z.object({
  url: z
    .string({ error: 'Paste a link' })
    .trim()
    .min(1, { error: 'Paste a link' })
    .max(2000, { error: 'The link is too long' })
    // Links copied without "https://" still work.
    .transform((v) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`))
    .pipe(z.url({ protocol: /^https?$/, error: 'This is not a valid link' })),
});

const linkVariant = z.object({
  values: z.array(z.string()),
  price: z.number().nullable(),
  salePrice: z.number().nullable(),
  image: z.string().nullable(),
});

export const linkProductSchema = z
  .object({
    url: z.string(),
    site: z.string().meta({ example: 'daraz.com.bd' }),
    source: z.enum(['woocommerce', 'shopify', 'daraz', 'page']).meta({ description: 'Which kind of data the product was read from' }),
    name: z.string(),
    shortDescription: z.string().nullable(),
    description: z.string().nullable().meta({ description: 'Cleaned HTML, without pictures' }),
    price: z.number().nullable(),
    salePrice: z.number().nullable(),
    currency: z.string().nullable().meta({ example: 'BDT' }),
    brand: z.string().nullable(),
    categories: z.array(z.string()).meta({ description: 'Category names on the site, broadest first' }),
    tags: z.array(z.string()),
    specs: z.array(z.object({ name: z.string(), value: z.string() })),
    images: z.array(z.string()),
    options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
    variants: z.array(linkVariant),
    notes: z.array(z.string()).meta({ description: 'Things to tell the user, e.g. that the price was missing' }),
  })
  .meta({ id: 'LinkProduct' });

export const linkReadResponse = z
  .object({
    product: linkProductSchema,
    match: z
      .object({ brandId: z.number().nullable(), categoryIds: z.array(z.number()) })
      .meta({ description: 'Our brand and categories with the same names, to preselect' }),
  })
  .meta({ id: 'LinkRead' });

const linkMoney = z.number({ error: 'Enter the price' }).min(0, { error: 'The price cannot be negative' }).max(9_999_999);

/** What the user checked and chose. The product is saved as a draft. */
export const linkCreateBody = z
  .object({
    url: z.url({ protocol: /^https?$/ }).meta({ description: 'The page the product was copied from' }),
    name: z.string().trim().min(2, { error: 'Name must be at least 2 characters' }).max(200, { error: 'Name is too long' }),
    shortDescription: z.string().max(1000).nullable().default(null),
    description: z.string().max(100_000).nullable().default(null),
    images: z.array(z.url({ protocol: /^https?$/ })).max(20, { error: 'At most 20 pictures' }).default([]),
    brandId: z.number().int().positive().nullable().default(null),
    newBrand: z.string().trim().min(1).max(100).nullable().default(null).meta({ description: 'Create this brand (when brandId is empty)' }),
    categoryIds: z.array(z.number().int().positive()).max(20).default([]),
    tags: z.array(z.string()).max(30).default([]),
    specs: z.array(z.object({ name: z.string(), value: z.string() })).max(50).default([]),
    options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).max(3).default([]),
    variants: z
      .array(
        z.object({
          values: z.array(z.string()).max(3).default([]),
          price: linkMoney,
          salePrice: linkMoney.nullable().default(null),
          image: z.url({ protocol: /^https?$/ }).nullable().default(null),
        }),
      )
      .min(1, { error: 'Enter the price' })
      .max(100),
  })
  .meta({ id: 'LinkCreateBody' });

export type LinkCreateInput = z.infer<typeof linkCreateBody>;

export const linkCreateResponse = z
  .object({
    productId: z.number(),
    importId: z.number().meta({ description: 'The entry in the import history' }),
    note: z.string().nullable().meta({ description: 'E.g. pictures that could not be downloaded' }),
  })
  .meta({ id: 'LinkCreated' });
