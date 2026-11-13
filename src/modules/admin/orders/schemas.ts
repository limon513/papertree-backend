import { z } from 'zod';
import { ORDER_CHANNELS, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from '../../../db/schema/index.ts';
import { bdPhone } from '../../../lib/phone.ts';
import { addressSchema } from '../customers/schemas.ts';
import { mediaSchema } from '../media/schemas.ts';
import { emailSchema, nameSchema, optionalText } from '../schemas.ts';

const id = z.number().int().positive();

const money = (label: string) =>
  z
    .number({ error: `Enter the ${label}` })
    .min(0, { error: `The ${label} cannot be negative` })
    .max(9_999_999, { error: `The ${label} is too high` })
    .transform((v) => Math.round(v * 100) / 100);

// ---- Create / edit ----

const itemInput = z.object({
  variantId: id,
  quantity: z
    .number({ error: 'Enter the quantity' })
    .int({ error: 'Quantity must be a whole number' })
    .min(1, { error: 'At least 1' })
    .max(99_999, { error: 'Too many' }),
  /** A different price for this order (e.g. a phone deal). Leave out to use the product price. */
  unitPrice: money('price').optional(),
  /**
   * Bulk discount on top of this line's price (retail orders). Default: yes for the product price, no for a
   * typed price. Editing an order sends its agreed price with bulk: true, so the discount follows the quantity.
   */
  bulk: z.boolean().optional(),
});

/** Prices for the order form, before saving: the same sums the order will have. */
export const priceBody = z
  .object({
    type: z.enum(['retail', 'wholesale']).default('retail'),
    items: z.array(itemInput).max(100, { error: 'At most 100 lines' }),
    /** With a coupon: the order's phone (for per-customer rules), the delivery charge (free-delivery coupons) and, when editing, the order. */
    couponCode: z.string().trim().max(30).nullable().default(null),
    phone: z.string().trim().max(20).nullable().default(null),
    deliveryFee: z.number().min(0).nullable().default(null),
    orderId: z.number().int().positive().nullable().default(null),
  })
  .meta({ id: 'OrderPriceBody' });

export const orderBody = z
  .object({
    type: z.enum(['retail', 'wholesale']).default('retail').meta({ description: 'wholesale uses wholesale prices and terms' }),
    channel: z.enum(ORDER_CHANNELS).default('phone').meta({ description: 'Where the order came from' }),
    paymentMethod: z.enum(PAYMENT_METHODS).default('cod'),
    customer: z.object({
      name: nameSchema,
      phone: bdPhone,
      email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    }),
    districtId: z.string({ error: 'Choose a district' }).min(1, { error: 'Choose a district' }),
    areaId: z.string().nullable().default(null),
    address: z
      .string({ error: 'Enter the address' })
      .trim()
      .min(5, { error: 'Enter the full address (house, road, area)' })
      .max(500, { error: 'The address is too long' }),
    items: z.array(itemInput).min(1, { error: 'Add at least one product' }).max(100, { error: 'At most 100 lines' }),
    discount: money('discount').default(0),
    /** null = work it out from the delivery zones. */
    deliveryFee: money('delivery charge').nullable().default(null),
    customerNote: optionalText(1000).default(null),
    staffNote: optionalText(2000).default(null),
    /** A coupon code (retail only). Checked and worked out on the server. */
    couponCode: z.string().trim().max(30).nullable().default(null).meta({ example: 'SCHOOL10' }),
    /** Where the stock is taken from. Default: the default stock location. */
    locationId: id.optional(),
  })
  .meta({ id: 'OrderBody' });

export type OrderInput = z.infer<typeof orderBody>;

/** What changes when an order moves on. */
export const STATUS_FLOW: Record<(typeof ORDER_STATUSES)[number], (typeof ORDER_STATUSES)[number][]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'shipped', 'cancelled', 'pending'],
  packed: ['shipped', 'cancelled', 'confirmed'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

export const statusBody = z
  .object({
    status: z.enum(ORDER_STATUSES),
    note: optionalText(1000).default(null),
    courier: optionalText(60).optional().meta({ description: 'When shipping: the courier, e.g. Steadfast' }),
    trackingCode: optionalText(100).optional(),
    /** When delivered: record the unpaid amount as collected by the courier (cash on delivery). */
    collectDue: z.boolean().default(false),
    /** Tell the customer by SMS / email (as chosen in Settings → Customer messages). */
    notify: z.boolean().default(true).meta({ description: 'Tell the customer (Settings → Customer messages chooses SMS and/or email). Sent a minute later; skipped if the order moved on by then.' }),
  })
  .meta({ id: 'OrderStatusBody' });

export const paymentBody = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amount: z
      .number({ error: 'Enter the amount' })
      .min(-9_999_999)
      .max(9_999_999)
      .refine((v) => v !== 0, { error: 'Enter the amount' })
      .transform((v) => Math.round(v * 100) / 100)
      .meta({ description: 'Negative for money paid back' }),
    reference: optionalText(100).default(null).meta({ description: 'bKash/Nagad transaction id, bank reference, ...' }),
    note: optionalText(500).default(null),
  })
  .meta({ id: 'OrderPaymentBody' });

export const noteBody = z.object({ note: z.string().trim().min(1, { error: 'Write a note' }).max(2000) }).meta({ id: 'OrderNoteBody' });

export const courierBody = z
  .object({ courier: optionalText(60).default(null), trackingCode: optionalText(100).default(null) })
  .meta({ id: 'OrderCourierBody' });

export const orderListQuery = z.object({
  search: z.string().trim().max(100).optional().meta({ description: 'Order number, phone or name' }),
  status: z.enum([...ORDER_STATUSES, 'open']).optional().meta({ description: 'open = not delivered, cancelled or returned' }),
  payment: z.enum(PAYMENT_STATUSES).optional(),
  channel: z.enum(ORDER_CHANNELS).optional(),
  type: z.enum(['retail', 'wholesale']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export const variantSearchQuery = z.object({
  q: z.string().trim().max(100).default(''),
  locationId: z.coerce.number().int().positive().optional(),
});

export const customerLookupQuery = z.object({ phone: z.string().trim().min(3).max(20) });

// ---- Responses (used for docs) ----

const statusEnum = z.enum(ORDER_STATUSES);

export const orderListItem = z.object({
  id: z.number(),
  number: z.number(),
  status: statusEnum,
  paymentStatus: z.enum(PAYMENT_STATUSES),
  paymentMethod: z.enum(PAYMENT_METHODS),
  channel: z.enum(ORDER_CHANNELS),
  type: z.enum(['retail', 'wholesale']),
  customerName: z.string(),
  phone: z.string(),
  districtName: z.string(),
  areaName: z.string().nullable(),
  items: z.number(),
  total: z.number(),
  paidAmount: z.number(),
  createdAt: z.iso.datetime(),
});

export const orderList = z
  .object({
    items: z.array(orderListItem),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    counts: z.record(z.string(), z.number()).meta({ description: 'Orders per status (ignoring the status filter)' }),
  })
  .meta({ id: 'OrderList' });

export const orderDetail = z
  .object({
    id: z.number(),
    number: z.number(),
    status: statusEnum,
    nextStatuses: z.array(statusEnum),
    canEdit: z.boolean(),
    items: z.array(
      z.object({
        id: z.number(),
        productId: z.number().nullable(),
        variantId: z.number().nullable(),
        name: z.string(),
        variantLabel: z.string().nullable(),
        sku: z.string().nullable(),
        image: mediaSchema.nullable(),
        regularPrice: z.number(),
        unitPrice: z.number(),
        quantity: z.number(),
        lineTotal: z.number(),
      }),
    ),
    payments: z.array(
      z.object({ id: z.number(), method: z.enum(PAYMENT_METHODS), amount: z.number(), reference: z.string().nullable(), note: z.string().nullable(), by: z.string().nullable(), createdAt: z.iso.datetime() }),
    ),
    events: z.array(z.object({ id: z.number(), type: z.string(), message: z.string(), by: z.string().nullable(), createdAt: z.iso.datetime() })),
    messages: z
      .array(
        z.object({
          id: z.number(),
          channel: z.enum(['sms', 'email']),
          purpose: z.string().meta({ example: 'order.shipped #100036' }),
          to: z.string(),
          status: z.enum(['sent', 'failed', 'logged']).meta({ description: 'logged: test mode, written down but not sent' }),
          error: z.string().nullable(),
          createdAt: z.iso.datetime(),
        }),
      )
      .meta({ description: 'SMS and emails the customer was sent about this order, newest first' }),
    customer: z
      .object({
        id: z.number(),
        type: z.enum(['retail', 'business']),
        businessName: z.string().nullable(),
        isBlocked: z.boolean(),
        blockedReason: z.string().nullable(),
        termsNote: z.string().nullable(),
        orders: z.number(),
      })
      .nullable(),
  })
  .catchall(z.unknown())
  .meta({ id: 'OrderDetail', description: 'All order fields, plus items, payments and history' });

export const variantSearchResult = z
  .object({
    items: z.array(
      z.object({
        variantId: z.number(),
        productId: z.number(),
        name: z.string(),
        variantLabel: z.string().nullable(),
        sku: z.string().nullable(),
        status: z.string(),
        image: mediaSchema.nullable(),
        price: z.number().meta({ description: 'Retail price now (sale price when on sale)' }),
        regularPrice: z.number(),
        wholesalePrice: z.number().nullable(),
        weightGrams: z.number().nullable(),
        trackStock: z.boolean(),
        allowBackorder: z.boolean(),
        stock: z.number().meta({ description: 'At the chosen (or default) location' }),
      }),
    ),
  })
  .meta({ id: 'OrderVariantSearch' });

export const customerLookup = z
  .object({
    customer: z
      .object({
        id: z.number(),
        name: z.string(),
        phone: z.string(),
        email: z.string().nullable(),
        type: z.enum(['retail', 'business']),
        businessName: z.string().nullable(),
        wholesale: z.boolean().meta({ description: 'Approved business: wholesale prices and its own terms' }),
        termsNote: z.string().nullable(),
        isBlocked: z.boolean(),
        blockedReason: z.string().nullable(),
      })
      .nullable(),
    orders: z.number(),
    addresses: z.array(addressSchema).meta({ description: 'Saved addresses, default first' }),
    lastAddress: z
      .object({ districtId: z.string(), areaId: z.string().nullable(), address: z.string() })
      .nullable()
      .meta({ description: 'The default address, to fill in the form' }),
  })
  .meta({ id: 'OrderCustomerLookup' });
