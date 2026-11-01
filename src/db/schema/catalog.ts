import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, ref, timestamps } from './_helpers.ts';
import { media } from './media.ts';

/** Image wins over icon on the website. The icon is a key from src/lib/catalog-icons.ts. */
const picture = () => ({
  imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
  icon: text('icon'),
});

/**
 * Product categories, up to 3 levels deep (e.g. Paper > Art Paper > Watercolor Paper).
 * The slug is unique across all categories, so old WordPress links can map to it.
 */
export const categories = pgTable(
  'categories',
  {
    id: id(),
    parentId: ref('parent_id').references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    ...picture(),
    /** Order among categories with the same parent. */
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    ...timestamps,
  },
  (t) => [index('categories_parent_id_idx').on(t.parentId, t.sortOrder)],
);

export const brands = pgTable(
  'brands',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    ...picture(),
    isActive: boolean('is_active').notNull().default(true),
    /** Shown first in the storefront's brand shop. */
    isFeatured: boolean('is_featured').notNull().default(false),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    ...timestamps,
  },
  (t) => [uniqueIndex('brands_name_lower_idx').on(sql`lower(${t.name})`)],
);
