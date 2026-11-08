import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

export type ProductRequestStatus = 'new' | 'done';

/**
 * "Request this product": a shopper asks for something the shop does not have (sent from the
 * website when a search finds nothing). Staff call back and mark it done.
 */
export const productRequests = pgTable(
  'product_requests',
  {
    id: id(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    /** What they are looking for, in their words. */
    details: text('details').notNull(),
    /** The search that found nothing, when sent from search. */
    query: text('query'),
    status: text('status').$type<ProductRequestStatus>().notNull().default('new'),
    /** Staff's note: "ordered from supplier", "told them it comes next week". */
    staffNote: text('staff_note'),
    handledBy: ref('handled_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    handledAt: timestamptz('handled_at'),
    ...timestamps,
  },
  (t) => [index('product_requests_status_idx').on(t.status, t.createdAt)],
);
