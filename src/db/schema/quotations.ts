import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgSequence, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { customers } from './customers.ts';
import { media } from './media.ts';
import { orders, type OrderType } from './orders.ts';
import { products, productVariants } from './products.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

export const QUOTATION_STATUSES = ['open', 'ordered', 'cancelled'] as const;
/** open (valid until its date, then shown as expired), ordered (the customer ordered it), cancelled. */
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/** Quotation numbers: Q-1001, Q-1002, ... */
export const quotationNumberSeq = pgSequence('quotation_number_seq', { startWith: 1001 });

/**
 * A quotation: products at fixed prices, valid until a date. Made by a shopper from their cart (today's
 * prices, bulk discounts or their wholesale prices included) or by staff. The customer can order it
 * online at these prices while it is valid; delivery is worked out when they order.
 */
export const quotations = pgTable(
  'quotations',
  {
    id: id(),
    number: integer('number')
      .notNull()
      .unique()
      .default(sql`nextval('quotation_number_seq')`),
    /** The secret in the quotation's link (the page and "Order this quotation"). */
    publicToken: text('public_token').notNull().unique(),
    /** website: made by a shopper; staff: made in the admin. */
    source: text('source').$type<'website' | 'staff'>().notNull(),
    type: text('type').$type<OrderType>().notNull().default('retail'),
    status: text('status').$type<QuotationStatus>().notNull().default('open'),
    /** Only when made by a signed-in shopper (or staff for a known customer): never matched by phone alone. */
    customerId: ref('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** Who it is for: a person, and their school, office or shop. */
    name: text('name').notNull(),
    organisation: text('organisation'),
    phone: text('phone').notNull(),
    email: text('email'),
    /** Their reference ("Class 5 supplies, term 2"). */
    note: text('note'),
    /** Items only (delivery comes when ordering): after bulk discounts. */
    subtotal: money('subtotal').notNull(),
    bulkDiscount: money('bulk_discount').notNull().default(0),
    validUntil: timestamptz('valid_until').notNull(),
    orderId: ref('order_id').references(() => orders.id, { onDelete: 'set null' }),
    orderedAt: timestamptz('ordered_at'),
    cancelledAt: timestamptz('cancelled_at'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('quotations_status_idx').on(t.status, t.createdAt), index('quotations_phone_idx').on(t.phone)],
);

/** A quotation's lines, with the prices fixed when it was made. */
export const quotationItems = pgTable(
  'quotation_items',
  {
    id: id(),
    quotationId: ref('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'cascade' }),
    productId: ref('product_id').references(() => products.id, { onDelete: 'set null' }),
    variantId: ref('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    variantLabel: text('variant_label'),
    sku: text('sku'),
    imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** The normal price then, to show the saving. */
    regularPrice: money('regular_price').notNull(),
    /** Per piece, after any bulk discount: what the customer pays when ordering. */
    unitPrice: money('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: money('line_total').notNull(),
    bulkPercent: numeric('bulk_percent', { precision: 5, scale: 2, mode: 'number' }),
    bulkDiscount: money('bulk_discount').notNull().default(0),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('quotation_items_quotation_id_idx').on(t.quotationId)],
);
