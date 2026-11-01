import { z } from 'zod';
import { mediaSchema } from '../media/schemas.ts';
import { optionalText, seoFields, slugInput } from '../schemas.ts';

export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 100;
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;

const id = z.number().int().positive();
const shortText = (label: string, max = 100) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(max, { error: `${label} is too long` });

const money = (label: string) =>
  z
    .number({ error: `Enter the ${label}` })
    .min(0, { error: `The ${label} cannot be negative` })
    .max(9_999_999, { error: `The ${label} is too high` })
    .transform((v) => Math.round(v * 100) / 100);

const optionalMoney = (label: string) => money(label).nullable();

const optionInput = z.object({
  name: shortText('Option name', 40),
  values: z
    .array(shortText('Option value', 60))
    .min(1, { error: 'Add at least one value' })
    .max(50, { error: 'At most 50 values per option' })
    .refine((list) => new Set(list.map((v) => v.toLowerCase())).size === list.length, {
      error: 'Each value can be used once',
    }),
});

const stockInput = z.object({
  locationId: id,
  quantity: z.number({ error: 'Enter the stock' }).int({ error: 'Stock must be a whole number' }).min(-99_999).max(9_999_999),
  /**
   * The quantity the form started from. When given, only the difference is applied, so orders
   * placed while the form was open are not overwritten.
   */
  baseQuantity: z.number().int().optional(),
});

const variantInput = z.object({
  /** Existing variant id. Leave out for a new variant. */
  id: id.optional(),
  option1: z.string().trim().max(60).nullable().default(null),
  option2: z.string().trim().max(60).nullable().default(null),
  option3: z.string().trim().max(60).nullable().default(null),
  sku: optionalText(64).default(null),
  barcode: optionalText(64).default(null),
  price: money('price'),
  salePrice: optionalMoney('sale price').default(null),
  saleStartsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  saleEndsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  wholesalePrice: optionalMoney('wholesale price').default(null),
  costPrice: optionalMoney('cost price').default(null),
  weightGrams: z.number().int({ error: 'Weight must be in whole grams' }).min(0).max(1_000_000).nullable().default(null),
  imageId: id.nullable().default(null),
  trackStock: z.boolean().default(true),
  allowBackorder: z.boolean().default(false),
  lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable().default(null),
  stock: z.array(stockInput).max(50).default([]),
});

/** The whole product form. Used for both create (POST) and save (PUT). */
export const productBody = z
  .object({
    name: z
      .string({ error: 'Name is required' })
      .trim()
      .min(2, { error: 'Name must be at least 2 characters' })
      .max(200, { error: 'Name is too long' }),
    slug: slugInput.optional(),
    status: z.enum(PRODUCT_STATUSES).default('draft'),
    shortDescription: optionalText(1000).default(null),
    description: z.string().max(100_000, { error: 'Description is too long' }).nullable().default(null),
    brandId: id.nullable().default(null),
    categoryIds: z.array(id).max(20, { error: 'At most 20 categories' }).default([]),
    /** Main category. Must be one of categoryIds. Defaults to the first. */
    primaryCategoryId: id.nullable().default(null),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(30, { error: 'At most 30 tags' })
      .default([])
      // Same tag in different case: keep the first one typed.
      .transform((list) => list.filter((t, i) => list.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)),
    /** Gallery in order. The first is the main image. */
    imageIds: z.array(id).max(20, { error: 'At most 20 images' }).default([]),
    options: z.array(optionInput).max(MAX_OPTIONS, { error: `At most ${MAX_OPTIONS} options` }).default([]),
    specs: z
      .array(z.object({ name: shortText('Name', 60), value: shortText('Value', 200) }))
      .max(50, { error: 'At most 50 specifications' })
      .default([]),
    variants: z
      .array(variantInput)
      .min(1, { error: 'A product needs at least one variant' })
      .max(MAX_VARIANTS, { error: `At most ${MAX_VARIANTS} variants` }),
    seoTitle: seoFields.seoTitle.default(null),
    seoDescription: seoFields.seoDescription.default(null),
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

    // Option names must differ.
    const names = p.options.map((o) => o.name.toLowerCase());
    p.options.forEach((o, i) => {
      if (names.indexOf(o.name.toLowerCase()) !== i) issue(['options', i, 'name'], 'Each option name can be used once');
    });

    if (p.options.length === 0 && p.variants.length > 1) {
      issue(['variants'], 'Add options (like Colour or Size) to have more than one variant');
    }

    const combos = new Set<string>();
    const skus = new Map<string, number>();
    p.variants.forEach((v, i) => {
      const values = [v.option1, v.option2, v.option3];
      p.options.forEach((o, n) => {
        const value = values[n];
        if (!value) issue(['variants', i, `option${n + 1}`], `Choose a ${o.name}`);
        else if (!o.values.some((ov) => ov.toLowerCase() === value.toLowerCase())) {
          issue(['variants', i, `option${n + 1}`], `"${value}" is not a ${o.name} value`);
        }
      });
      for (let n = p.options.length; n < MAX_OPTIONS; n++) {
        if (values[n]) issue(['variants', i, `option${n + 1}`], 'This product has no such option');
      }
      if (p.options.length > 0) {
        const combo = values.map((x) => x?.toLowerCase() ?? '').join('|');
        if (combos.has(combo)) issue(['variants', i], 'Two variants have the same options');
        combos.add(combo);
      }

      if (v.sku) {
        const key = v.sku.toLowerCase();
        if (skus.has(key)) issue(['variants', i, 'sku'], 'This SKU is used by another variant');
        skus.set(key, i);
      }
      if (v.salePrice !== null && v.salePrice >= v.price) {
        issue(['variants', i, 'salePrice'], 'The sale price must be lower than the price');
      }
      if (v.saleStartsAt && v.saleEndsAt && new Date(v.saleEndsAt) <= new Date(v.saleStartsAt)) {
        issue(['variants', i, 'saleEndsAt'], 'The sale must end after it starts');
      }
      if (new Set(v.stock.map((s) => s.locationId)).size !== v.stock.length) {
        issue(['variants', i, 'stock'], 'Each location can be listed once');
      }
    });

    if (p.primaryCategoryId !== null && !p.categoryIds.includes(p.primaryCategoryId)) {
      issue(['primaryCategoryId'], 'The main category must be one of the chosen categories');
    }
    if (new Set(p.imageIds).size !== p.imageIds.length) issue(['imageIds'], 'An image is in the gallery twice');
  })
  .meta({ id: 'ProductBody' });

export type ProductInput = z.infer<typeof productBody>;

export const productListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  brandId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  sort: z.enum(['updated', 'name', 'price']).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---- Responses (used for docs) ----

const stockLevel = z.object({ locationId: z.number(), quantity: z.number() });

export const variantSchema = z.object({
  id: z.number(),
  option1: z.string().nullable(),
  option2: z.string().nullable(),
  option3: z.string().nullable(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price: z.number(),
  salePrice: z.number().nullable(),
  saleStartsAt: z.iso.datetime().nullable(),
  saleEndsAt: z.iso.datetime().nullable(),
  wholesalePrice: z.number().nullable(),
  costPrice: z.number().nullable(),
  weightGrams: z.number().nullable(),
  imageId: z.number().nullable(),
  image: mediaSchema.nullable(),
  trackStock: z.boolean(),
  allowBackorder: z.boolean(),
  lowStockThreshold: z.number().nullable(),
  position: z.number(),
  stock: z.array(stockLevel),
});

export const productSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(PRODUCT_STATUSES),
    shortDescription: z.string().nullable(),
    description: z.string().nullable(),
    brandId: z.number().nullable(),
    categoryIds: z.array(z.number()),
    primaryCategoryId: z.number().nullable(),
    tags: z.array(z.string()),
    images: z.array(mediaSchema),
    options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
    specs: z.array(z.object({ name: z.string(), value: z.string() })),
    variants: z.array(variantSchema),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Product' });

export const productListItem = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(PRODUCT_STATUSES),
  image: mediaSchema.nullable(),
  brand: z.object({ id: z.number(), name: z.string() }).nullable(),
  variantCount: z.number(),
  priceMin: z.number(),
  priceMax: z.number(),
  onSale: z.boolean(),
  /** Sum over variants that track stock. null when no variant tracks stock. */
  totalStock: z.number().nullable(),
  updatedAt: z.iso.datetime(),
});

export const productList = z
  .object({
    items: z.array(productListItem),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    counts: z.object({ all: z.number(), draft: z.number(), active: z.number(), archived: z.number() }),
  })
  .meta({ id: 'ProductList' });

export const stockLocationList = z
  .object({
    items: z.array(z.object({ id: z.number(), name: z.string(), isDefault: z.boolean(), isActive: z.boolean() })),
  })
  .meta({ id: 'StockLocationList' });
