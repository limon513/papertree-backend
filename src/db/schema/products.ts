import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { brands, categories } from './catalog.ts';
import { media } from './media.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

/** Money in taka with paisa, e.g. 120.50. */
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

/** Places that hold stock: the warehouse now, a physical shop later. */
export const stockLocations = pgTable(
  'stock_locations',
  {
    id: id(),
    name: text('name').notNull().unique(),
    /** Where stock goes when no location is chosen (e.g. new products, imports). */
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  // Only one default location.
  (t) => [uniqueIndex('stock_locations_one_default_idx').on(t.isDefault).where(sql`${t.isDefault}`)],
);

export type ProductStatus = 'draft' | 'active' | 'archived';

/** A product option such as Colour with its values. At most 3 per product. */
export interface ProductOption {
  name: string;
  values: string[];
}

/** A specification line, e.g. { name: 'GSM', value: '80' }. Used for filters on the website. */
export interface ProductSpec {
  name: string;
  value: string;
}

/**
 * Every product has at least one variant. A simple product has one variant and no options.
 * Prices and stock live on the variants.
 */
export const products = pgTable(
  'products',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    status: text('status').$type<ProductStatus>().notNull().default('draft'),
    shortDescription: text('short_description'),
    /** Cleaned HTML from the editor. */
    description: text('description'),
    brandId: ref('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    tags: text('tags').array().notNull().default([]),
    options: jsonb('options').$type<ProductOption[]>().notNull().default([]),
    specs: jsonb('specs').$type<ProductSpec[]>().notNull().default([]),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    /** First time the product was published. */
    publishedAt: timestamptz('published_at'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('products_status_idx').on(t.status),
    index('products_brand_id_idx').on(t.brandId),
    index('products_updated_at_idx').on(t.updatedAt),
  ],
);

/** A product can be in several categories. One of them is the main one (breadcrumbs, URLs). */
export const productCategories = pgTable(
  'product_categories',
  {
    productId: ref('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: ref('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.productId, t.categoryId] }), index('product_categories_category_id_idx').on(t.categoryId)],
);

/** Gallery images in order. Position 0 is the main image. */
export const productImages = pgTable(
  'product_images',
  {
    productId: ref('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    mediaId: ref('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.mediaId] })],
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    productId: ref('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Values for the product's options, in the same order. Empty for a simple product. */
    option1: text('option1'),
    option2: text('option2'),
    option3: text('option3'),
    sku: text('sku'),
    barcode: text('barcode'),
    /** Regular retail price. */
    price: money('price').notNull(),
    salePrice: money('sale_price'),
    /** Optional sale window. Without dates the sale price applies whenever it is set. */
    saleStartsAt: timestamptz('sale_starts_at'),
    saleEndsAt: timestamptz('sale_ends_at'),
    /** Price for approved business (wholesale) customers. */
    wholesalePrice: money('wholesale_price'),
    /** What we pay for it. Admin only, for profit reports. */
    costPrice: money('cost_price'),
    weightGrams: integer('weight_grams'),
    imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
    trackStock: boolean('track_stock').notNull().default(true),
    /** Allow orders when stock is 0. */
    allowBackorder: boolean('allow_backorder').notNull().default(false),
    lowStockThreshold: integer('low_stock_threshold'),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('product_variants_product_id_idx').on(t.productId),
    uniqueIndex('product_variants_sku_idx')
      .on(sql`lower(${t.sku})`)
      .where(sql`${t.sku} is not null`),
    // The same option combination cannot appear twice in one product (empty options count as equal).
    unique('product_variants_options_key').on(t.productId, t.option1, t.option2, t.option3).nullsNotDistinct(),
  ],
);

/** Stock on hand per variant per location. */
export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    variantId: ref('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    locationId: ref('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.locationId] }), index('inventory_levels_location_id_idx').on(t.locationId)],
);

export type StockChangeReason = 'initial' | 'adjustment' | 'order' | 'return' | 'import';

/** Every stock change, so we can always see why a number changed. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: id(),
    variantId: ref('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    locationId: ref('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    /** + added, - removed. */
    change: integer('change').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    reason: text('reason').$type<StockChangeReason>().notNull(),
    note: text('note'),
    adminUserId: ref('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('inventory_movements_variant_id_idx').on(t.variantId, t.createdAt)],
);
