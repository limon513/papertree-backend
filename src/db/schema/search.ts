import { sql } from 'drizzle-orm';
import { customType, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { products } from './products.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Website search: one row per product with its searchable words. Kept up to date by database
 * triggers (see migration 0008), so product edits, imports, and brand or category renames all show
 * in search at once, whatever made the change.
 * - doc: name, brand, category names (with parents), tags and SKUs in lower case; the shop's words
 *   for spelling correction ("penicl" -> "pencil").
 * - tsv: the same words for full-text search, weighted name > brand/category > tags/SKU > short description.
 */
export const productSearch = pgTable(
  'product_search',
  {
    productId: ref('product_id')
      .primaryKey()
      .references(() => products.id, { onDelete: 'cascade' }),
    doc: text('doc').notNull(),
    tsv: tsvector('tsv').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('product_search_tsv_idx').using('gin', t.tsv)],
);

/**
 * Words that mean the same thing to shoppers, including Banglish ("khata" = notebook) and common
 * misspellings. A search for any of them finds products named with any other. Edited in the admin.
 */
export const searchSynonyms = pgTable('search_synonyms', {
  id: id(),
  /** Lower case words or short phrases: ["notebook", "khata", "exercise book"]. */
  terms: text('terms').array().notNull(),
  ...timestamps,
});

/** Searches made on the website (sent by the shopper's browser), for the search report. */
export const searchQueries = pgTable(
  'search_queries',
  {
    id: id(),
    query: text('query').notNull(),
    /** Products found (0 = the shop has nothing for it: worth stocking or adding a synonym). */
    results: integer('results').notNull(),
    /** What was searched instead, when the words were corrected. */
    correctedTo: text('corrected_to'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('search_queries_created_at_idx').on(t.createdAt), index('search_queries_query_idx').on(sql`lower(${t.query})`)],
);
