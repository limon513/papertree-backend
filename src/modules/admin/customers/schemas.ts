import { z } from 'zod';
import { bdPhone, optionalBdPhone } from '../../../lib/phone.ts';
import { emailSchema, nameSchema, optionalText } from '../schemas.ts';
import { WHOLESALE_DELIVERY } from '../settings/schemas.ts';

const money = (label: string) =>
  z
    .number({ error: `Enter the ${label}` })
    .min(0, { error: `The ${label} cannot be negative` })
    .max(9_999_999, { error: `The ${label} is too high` })
    .transform((v) => Math.round(v * 100) / 100);

const email = emailSchema.nullable().or(z.literal('').transform(() => null));

export const customerBody = z
  .object({
    name: nameSchema,
    phone: bdPhone,
    email: email.default(null),
    type: z.enum(['retail', 'business']).default('retail'),
    businessName: optionalText(150).default(null),
    tradeLicense: optionalText(60).default(null).meta({ description: 'Trade licence number' }),
    note: optionalText(2000).default(null).meta({ description: 'Staff only' }),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'business' && !c.businessName) {
      ctx.addIssue({ code: 'custom', path: ['businessName'], message: 'Enter the business name' });
    }
  })
  .meta({ id: 'CustomerBody' });

export type CustomerInput = z.infer<typeof customerBody>;

export const wholesaleTermsBody = z
  .object({
    advancePercent: z.number().min(0, { error: 'Cannot be negative' }).max(100, { error: 'At most 100%' }).nullable().default(null),
    minOrderAmount: money('minimum order').nullable().default(null),
    delivery: z.enum(WHOLESALE_DELIVERY).nullable().default(null),
    deliveryFee: money('delivery charge').nullable().default(null),
    note: optionalText(1000).default(null).meta({ description: 'e.g. "15 days credit" — shown to staff on orders' }),
  })
  .superRefine((t, ctx) => {
    if (t.delivery === 'fixed' && t.deliveryFee === null) {
      ctx.addIssue({ code: 'custom', path: ['deliveryFee'], message: 'Enter the delivery charge' });
    }
  })
  .meta({ id: 'WholesaleTerms', description: 'Empty fields use the shop terms' });

export const businessBody = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']),
    /** null = the shop's wholesale terms. */
    terms: wholesaleTermsBody.nullable().default(null),
  })
  .meta({ id: 'CustomerBusinessBody' });

export const blockBody = z
  .object({
    blocked: z.boolean(),
    reason: optionalText(500).default(null),
  })
  .superRefine((b, ctx) => {
    if (b.blocked && !b.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Write why, so other staff know' });
  })
  .meta({ id: 'CustomerBlockBody' });

export const addressBody = z
  .object({
    label: optionalText(40).default(null).meta({ example: 'Office' }),
    recipientName: optionalText(100).default(null),
    recipientPhone: optionalBdPhone.default(null),
    districtId: z.string({ error: 'Choose a district' }).min(1, { error: 'Choose a district' }),
    areaId: z.string().nullable().default(null),
    address: z
      .string({ error: 'Enter the address' })
      .trim()
      .min(5, { error: 'Enter the full address (house, road, area)' })
      .max(500, { error: 'The address is too long' }),
    isDefault: z.boolean().default(false),
  })
  .meta({ id: 'CustomerAddressBody' });

export type AddressInput = z.infer<typeof addressBody>;

export const CUSTOMER_SORTS = ['newest', 'last_order', 'spent', 'orders', 'name'] as const;

export const customerListQuery = z.object({
  search: z.string().trim().max(100).optional().meta({ description: 'Name, phone, email or business name' }),
  view: z
    .enum(['all', 'retail', 'business', 'pending', 'blocked'])
    .default('all')
    .meta({ description: 'business = approved business accounts; pending = waiting for approval' }),
  sort: z.enum(CUSTOMER_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
});

// ---- Responses (used for docs) ----

const stats = {
  orders: z.number().meta({ description: 'Orders that were not cancelled' }),
  spent: z.number().meta({ description: 'Total of delivered orders' }),
  due: z.number().meta({ description: 'Still to pay on open and delivered orders' }),
  lastOrderAt: z.iso.datetime().nullable(),
};

const customerFields = {
  id: z.number(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  type: z.enum(['retail', 'business']),
  businessName: z.string().nullable(),
  businessStatus: z.enum(['pending', 'approved', 'rejected']).nullable(),
  isBlocked: z.boolean(),
  createdAt: z.iso.datetime(),
};

export const customerList = z
  .object({
    items: z.array(z.object({ ...customerFields, ...stats })),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    counts: z.record(z.string(), z.number()),
  })
  .meta({ id: 'CustomerList' });

export const addressSchema = z
  .object({
    id: z.number(),
    label: z.string().nullable(),
    recipientName: z.string().nullable(),
    recipientPhone: z.string().nullable(),
    districtId: z.string(),
    districtName: z.string(),
    areaId: z.string().nullable(),
    areaName: z.string().nullable(),
    address: z.string(),
    isDefault: z.boolean(),
  })
  .meta({ id: 'CustomerAddress' });

const termsView = z.object({
  advancePercent: z.number().nullable(),
  minOrderAmount: z.number().nullable(),
  delivery: z.enum(WHOLESALE_DELIVERY).nullable(),
  deliveryFee: z.number().nullable(),
  note: z.string().nullable(),
});

export const customerDetail = z
  .object({
    ...customerFields,
    tradeLicense: z.string().nullable(),
    wholesaleTerms: termsView.nullable(),
    blockedReason: z.string().nullable(),
    note: z.string().nullable(),
    stats: z.object({ ...stats, averageOrder: z.number(), cancelled: z.number(), returned: z.number() }),
    addresses: z.array(addressSchema),
    orders: z.array(
      z.object({
        id: z.number(),
        number: z.number(),
        status: z.string(),
        paymentStatus: z.string(),
        type: z.enum(['retail', 'wholesale']),
        total: z.number(),
        paidAmount: z.number(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'CustomerDetail' });
