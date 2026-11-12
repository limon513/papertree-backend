import { z } from 'zod';
import { bdPhone } from '../../lib/phone.ts';
import { emailSchema, nameSchema, optionalText } from '../admin/schemas.ts';

/** "a,b" or repeated ?brand=a&brand=b -> ["a", "b"]. */
const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)));

export const productListQuery = z.object({
  category: z.string().trim().max(120).optional().meta({ description: 'Category slug; includes its sub-categories' }),
  brand: list.meta({ description: 'Brand slug(s), comma separated' }),
  q: z.string().trim().max(100).optional().meta({ description: 'Search words: typos are fixed, synonyms used ("khata" = notebook), a SKU is found' }),
  sort: z
    .enum(['relevance', 'popular', 'newest', 'price_asc', 'price_desc', 'name', 'deals'])
    .optional()
    .meta({ description: 'Default: relevance when searching, else popular' }),
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

/** One search made on the website, as the browser reports it. */
export const searchLogBody = z
  .object({
    query: z.string().trim().min(1).max(100),
    results: z.number().int().min(0).max(100_000),
    correctedTo: z.string().trim().max(100).nullable().default(null),
  })
  .meta({ id: 'StoreSearchLogBody' });

export const cartBody = z
  .object({
    items: z
      .array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().min(1).max(9999) }))
      .max(100),
    /** Where it goes, for the delivery charge and free-delivery progress. */
    districtId: z.string().nullable().default(null),
    areaId: z.string().nullable().default(null),
    /** A coupon code to try on this cart. */
    couponCode: z.string().trim().max(30).nullable().default(null),
  })
  .meta({ id: 'StoreCartBody' });

/** "Request this product" from the website. */
export const productRequestBody = z
  .object({
    name: z.string({ error: 'Enter your name' }).trim().min(1, { error: 'Enter your name' }).max(100),
    phone: bdPhone,
    details: z.string({ error: 'Tell us what you are looking for' }).trim().min(2, { error: 'Tell us what you are looking for' }).max(1000),
    query: z.string().trim().max(100).nullable().default(null),
    /** Left empty by people; bots fill every box. */
    website: z.string().max(200).optional(),
  })
  .meta({ id: 'StoreProductRequestBody' });

/** Placing an order from the website (cash on delivery for now). */
export const checkoutBody = z
  .object({
    name: nameSchema,
    phone: bdPhone,
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    districtId: z.string({ error: 'Choose your district' }).min(1, { error: 'Choose your district' }),
    areaId: z.string().nullable().default(null),
    address: z
      .string({ error: 'Enter your address' })
      .trim()
      .min(5, { error: 'Enter the full address (house, road, area)' })
      .max(500, { error: 'The address is too long' }),
    note: optionalText(1000).default(null),
    items: z
      .array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().min(1).max(9999) }))
      .min(1, { error: 'Your cart is empty' })
      .max(100),
    paymentMethod: z.enum(['cod']).default('cod'),
    /** The total the shopper saw: if prices changed since, the order is not placed (409 PRICE_CHANGED). */
    expectedTotal: z.number().min(0),
    /** A new id per checkout attempt; sending the same one again returns the same order. */
    requestId: z.string().min(8).max(64),
    /** Only when the cart check said it applies; checked again here. */
    couponCode: z.string().trim().max(30).nullable().default(null),
    /** Left empty by people; bots fill every box. */
    website: z.string().max(200).optional(),
  })
  .meta({ id: 'StoreCheckoutBody' });
