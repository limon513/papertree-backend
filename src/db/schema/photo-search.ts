import { boolean, index, integer, pgTable, real, text, vector } from 'drizzle-orm/pg-core';
import { customers } from './customers.ts';
import { media } from './media.ts';
import { id, ref, timestamptz } from './_helpers.ts';

/** Numbers per picture from the image model (SigLIP base: 768). */
export const IMAGE_VECTOR_SIZE = 768;

/**
 * Search by photo: what each product picture "looks like", as numbers from an image model that runs
 * on our own server (no paid service). Pictures that look alike have close numbers, so a shopper's
 * photo finds the products whose pictures are closest. Filled in the background (job photo-index)
 * for every product picture; a picture's row goes when the picture is deleted.
 */
export const imageVectors = pgTable('image_vectors', {
  mediaId: ref('media_id')
    .primaryKey()
    .references(() => media.id, { onDelete: 'cascade' }),
  /** Which model made it: a new model fills the table again. */
  model: text('model').notNull(),
  embedding: vector('embedding', { dimensions: IMAGE_VECTOR_SIZE }).notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

/**
 * Searches made with a photo on the website, for the search report. The photo itself is kept only
 * when nothing close was found (what shoppers want that the shop lacks), for 30 days.
 */
export const photoSearches = pgTable(
  'photo_searches',
  {
    id: id(),
    /** Products shown. */
    results: integer('results').notNull(),
    /** How alike the best one was, 0–1. */
    bestScore: real('best_score'),
    /** The best one looked like the same item (or very close). */
    matched: boolean('matched').notNull(),
    /** The shopper drew a box around part of the photo. */
    cropped: boolean('cropped').notNull().default(false),
    bestProductId: ref('best_product_id'),
    customerId: ref('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    device: text('device'),
    /** Storage key of the photo (no close match only); removed after 30 days. */
    photoKey: text('photo_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('photo_searches_created_idx').on(t.createdAt)],
);
