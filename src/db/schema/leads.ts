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

export const SUPPLIER_LEAD_STATUSES = ['new', 'talking', 'done'] as const;
export type SupplierLeadStatus = (typeof SUPPLIER_LEAD_STATUSES)[number];
/** How a supplier would like to work with the shop. */
export const SUPPLIER_WAYS = ['wholesale', 'brand', 'unsure'] as const;
export type SupplierWay = (typeof SUPPLIER_WAYS)[number];

/**
 * "Sell with us": a brand, maker or wholesaler who wants to sell through the shop leaves their
 * details on the website. Staff talk to them and close the lead with a note. A lead only: nothing
 * is listed or ordered from here.
 */
export const supplierLeads = pgTable(
  'supplier_leads',
  {
    id: id(),
    businessName: text('business_name').notNull(),
    contactName: text('contact_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    /** Where they are (city or district, in their words). */
    location: text('location'),
    /** What they make or sell. */
    products: text('products').notNull(),
    /** wholesale: they supply us at wholesale price; brand: we list their products and order per sale; unsure. */
    ways: text('ways').array().$type<SupplierWay[]>().notNull().default([]),
    /** Their website or Facebook page. */
    link: text('link'),
    message: text('message'),
    status: text('status').$type<SupplierLeadStatus>().notNull().default('new'),
    staffNote: text('staff_note'),
    handledBy: ref('handled_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    handledAt: timestamptz('handled_at'),
    ...timestamps,
  },
  (t) => [index('supplier_leads_status_idx').on(t.status, t.createdAt)],
);
