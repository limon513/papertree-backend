import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { customers } from './customers.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';
import { orders } from './orders.ts';
import { products } from './products.ts';

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** At most this many photos per review. */
export const MAX_REVIEW_PHOTOS = 2;

/**
 * A customer's rating and review of a product. Only customers who received it (a delivered order)
 * can write one, one per product; staff approve it before it shows. Editing sends it back to review.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: id(),
    productId: ref('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** The delivered order that shows they bought it. */
    orderId: ref('order_id').references(() => orders.id, { onDelete: 'set null' }),
    rating: integer('rating').notNull(),
    body: text('body'),
    /** Their photos (media ids they uploaded), in order. */
    photoIds: bigint('photo_ids', { mode: 'number' }).array().notNull().default([]),
    status: text('status').$type<ReviewStatus>().notNull().default('pending'),
    /** Why it was not approved (staff only). */
    rejectReason: text('reject_reason'),
    /** The shop's answer, shown under the review. */
    reply: text('reply'),
    repliedAt: timestamptz('replied_at'),
    decidedBy: ref('decided_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    decidedAt: timestamptz('decided_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('product_reviews_product_customer_idx').on(t.productId, t.customerId),
    index('product_reviews_product_status_idx').on(t.productId, t.status, t.createdAt),
    index('product_reviews_status_idx').on(t.status, t.createdAt),
    check('product_reviews_rating_range', sql`${t.rating} between 1 and 5`),
    check('product_reviews_photos_max', sql`cardinality(${t.photoIds}) <= ${sql.raw(String(MAX_REVIEW_PHOTOS))}`),
  ],
);
