import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgSequence, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { customers } from './customers.ts';
import { media } from './media.ts';
import { products, productVariants, stockLocations } from './products.ts';
import { deliveryZones } from './settings.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

export const ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const ORDER_CHANNELS = ['website', 'phone', 'facebook', 'whatsapp', 'shop', 'other'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];
export const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'bank', 'cash', 'card', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type OrderType = 'retail' | 'wholesale';

/** Order numbers shown to customers: 100001, 100002, ... */
export const orderNumberSeq = pgSequence('order_number_seq', { startWith: 100001 });

export const orders = pgTable(
  'orders',
  {
    id: id(),
    number: integer('number')
      .notNull()
      .unique()
      .default(sql`nextval('order_number_seq')`),
    customerId: ref('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    channel: text('channel').$type<OrderChannel>().notNull(),
    type: text('type').$type<OrderType>().notNull().default('retail'),
    status: text('status').$type<OrderStatus>().notNull().default('pending'),
    /** How the customer said they will pay. */
    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    paymentStatus: text('payment_status').$type<PaymentStatus>().notNull().default('unpaid'),

    // Contact and address as given for this order (kept even if the customer changes them later).
    customerName: text('customer_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    districtId: text('district_id').notNull(),
    districtName: text('district_name').notNull(),
    areaId: text('area_id'),
    areaName: text('area_name'),
    address: text('address').notNull(),

    deliveryZoneId: ref('delivery_zone_id').references(() => deliveryZones.id, { onDelete: 'set null' }),
    deliveryZoneName: text('delivery_zone_name'),
    /** Where the stock was taken from. */
    locationId: ref('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    weightGrams: integer('weight_grams').notNull().default(0),

    subtotal: money('subtotal').notNull(),
    discount: money('discount').notNull().default(0),
    deliveryFee: money('delivery_fee').notNull(),
    total: money('total').notNull(),
    /** Sum of the payments (refunds are negative). */
    paidAmount: money('paid_amount').notNull().default(0),
    /** Wholesale: what must be paid before the order is sent. */
    advanceRequired: money('advance_required').notNull().default(0),

    courier: text('courier'),
    trackingCode: text('tracking_code'),
    customerNote: text('customer_note'),
    staffNote: text('staff_note'),

    confirmedAt: timestamptz('confirmed_at'),
    shippedAt: timestamptz('shipped_at'),
    deliveredAt: timestamptz('delivered_at'),
    cancelledAt: timestamptz('cancelled_at'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    /** Website orders: the secret in the shopper's "thank you" link (no sign-in needed to see their order). */
    publicToken: text('public_token').unique(),
    /** Website orders: the browser's id for this attempt, so a double tap or a retry never makes two orders. */
    requestId: text('request_id').unique(),
    ...timestamps,
  },
  (t) => [
    index('orders_created_at_idx').on(t.createdAt),
    index('orders_status_idx').on(t.status, t.createdAt),
    index('orders_phone_idx').on(t.phone),
    index('orders_customer_id_idx').on(t.customerId),
  ],
);

/** A line of an order. Names and prices are copied, so the order never changes when the product does. */
export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: ref('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: ref('product_id').references(() => products.id, { onDelete: 'set null' }),
    variantId: ref('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** "Red / A4". Null for a product without options. */
    variantLabel: text('variant_label'),
    sku: text('sku'),
    imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** The normal price at the time, to show the saving. */
    regularPrice: money('regular_price').notNull(),
    unitPrice: money('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: money('line_total').notNull(),
    weightGrams: integer('weight_grams'),
    /** Units taken from stock for this line (0 for products that do not track stock). */
    stockTaken: integer('stock_taken').notNull().default(0),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('order_items_order_id_idx').on(t.orderId), index('order_items_variant_id_idx').on(t.variantId)],
);

/** Money received (positive) or paid back (negative). */
export const orderPayments = pgTable(
  'order_payments',
  {
    id: id(),
    orderId: ref('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    method: text('method').$type<PaymentMethod>().notNull(),
    amount: money('amount').notNull(),
    /** bKash/Nagad transaction id, bank reference, ... */
    reference: text('reference'),
    note: text('note'),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('order_payments_order_id_idx').on(t.orderId)],
);

export type OrderEventType = 'created' | 'edited' | 'status' | 'payment' | 'courier' | 'note';

/** The order's history: what happened, when, and who did it. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: ref('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').$type<OrderEventType>().notNull(),
    message: text('message').notNull(),
    adminUserId: ref('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('order_events_order_id_idx').on(t.orderId, t.createdAt)],
);
