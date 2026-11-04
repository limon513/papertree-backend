import { z } from 'zod';
import { ORDER_CHANNELS, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from '../../../db/schema/index.ts';
import { bdPhone } from '../../../lib/phone.ts';
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
});

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
    customer: z.object({ id: z.number(), type: z.enum(['retail', 'business']), orders: z.number() }).nullable(),
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
      .object({ id: z.number(), name: z.string(), phone: z.string(), email: z.string().nullable(), type: z.enum(['retail', 'business']) })
      .nullable(),
    orders: z.number(),
    lastAddress: z
      .object({ districtId: z.string(), areaId: z.string().nullable(), address: z.string() })
      .nullable()
      .meta({ description: 'From the latest order, to fill in the form' }),
  })
  .meta({ id: 'OrderCustomerLookup' });
