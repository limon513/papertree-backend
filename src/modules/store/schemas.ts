import { z } from 'zod';

/** "a,b" or repeated ?brand=a&brand=b -> ["a", "b"]. */
const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)));

export const productListQuery = z.object({
  category: z.string().trim().max(120).optional().meta({ description: 'Category slug; includes its sub-categories' }),
  brand: list.meta({ description: 'Brand slug(s), comma separated' }),
  q: z.string().trim().max(100).optional().meta({ description: 'Search words (name, brand, tags, SKU)' }),
  sort: z.enum(['popular', 'newest', 'price_asc', 'price_desc', 'name', 'deals']).default('popular'),
  min: z.coerce.number().min(0).optional(),
  max: z.coerce.number().min(0).optional(),
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  onSale: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(24),
});

export type ProductListQuery = z.infer<typeof productListQuery>;

export const suggestQuery = z.object({ q: z.string().trim().min(1).max(100) });

export const cartBody = z
  .object({
    items: z
      .array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().min(1).max(9999) }))
      .max(100),
    /** Where it goes, for the delivery charge and free-delivery progress. */
    districtId: z.string().nullable().default(null),
    areaId: z.string().nullable().default(null),
  })
  .meta({ id: 'StoreCartBody' });
