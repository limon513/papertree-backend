import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgSequence, pgTable, text } from 'drizzle-orm/pg-core';
import { customers } from './customers.ts';
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
    /** A photo of what they want (sent from search by photo): storage key. */
    photoKey: text('photo_key'),
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

// ---- Custom orders ----

export const CUSTOM_REQUEST_STATUSES = ['new', 'quoted', 'closed'] as const;
/** new; quoted (staff sent a priced quotation); closed (done, or not possible: see the note). */
export type CustomRequestStatus = (typeof CUSTOM_REQUEST_STATUSES)[number];
/** The kinds of things made to order (the website's Custom Order Studio asks its own questions for each). */
export const CUSTOM_KINDS = ['notebook', 'canvas', 'pen', 'paper', 'sketchbook', 'sticker', 'folder', 'other'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

/** Custom request numbers: CR-1001, CR-1002, ... */
export const customRequestNumberSeq = pgSequence('custom_request_number_seq', { startWith: 1001 });

/**
 * "Custom order": a customer describes something to be made (a printed notebook, branded pens...).
 * Staff call them, then send a priced quotation with the custom item, which the customer orders online.
 */
export const customRequests = pgTable(
  'custom_requests',
  {
    id: id(),
    number: integer('number')
      .notNull()
      .unique()
      .default(sql`nextval('custom_request_number_seq')`),
    kind: text('kind').$type<CustomKind>().notNull(),
    /** The answers, as asked ("Finished size": "A5"). */
    specs: jsonb('specs').$type<{ label: string; value: string }[]>().notNull().default([]),
    quantity: integer('quantity').notNull(),
    notes: text('notes'),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    city: text('city'),
    /** Only when signed in (needed to attach files). */
    customerId: ref('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    status: text('status').$type<CustomRequestStatus>().notNull().default('new'),
    staffNote: text('staff_note'),
    handledBy: ref('handled_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    handledAt: timestamptz('handled_at'),
    ...timestamps,
  },
  (t) => [index('custom_requests_status_idx').on(t.status, t.createdAt)],
);

/** Artwork for a custom request (images or PDF, signed-in customers only). Kept under a long random name. */
export const customRequestFiles = pgTable(
  'custom_request_files',
  {
    id: id(),
    /** null until the request is sent. */
    requestId: ref('request_id').references(() => customRequests.id, { onDelete: 'cascade' }),
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('custom_request_files_request_idx').on(t.requestId)],
);
