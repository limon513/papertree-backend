import { z } from 'zod';
import { bulkTiersSchema } from '../../../lib/bulk.ts';
import { optionalBdPhone } from '../../../lib/phone.ts';
import { mediaSchema } from '../media/schemas.ts';
import { emailSchema, nameSchema, optionalText } from '../schemas.ts';

const money = (label: string) =>
  z
    .number({ error: `Enter the ${label}` })
    .min(0, { error: `The ${label} cannot be negative` })
    .max(9_999_999, { error: `The ${label} is too high` })
    .transform((v) => Math.round(v * 100) / 100);

const link = z
  .string()
  .trim()
  .nullable()
  .transform((v) => v || null)
  .refine((v) => v === null || /^https?:\/\/\S+\.\S+/.test(v), { error: 'Enter the full link, starting with https://' });

// ---- Store details ----

export const storeSettings = z
  .object({
    name: nameSchema.default('PaperTree').meta({ example: 'PaperTree' }),
    tagline: optionalText(150).default(null),
    phone: optionalBdPhone.default(null),
    whatsapp: optionalBdPhone.default(null).meta({ description: 'Number for the WhatsApp chat button' }),
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    address: optionalText(500).default(null),
    openingHours: optionalText(200).default(null).meta({ example: 'Sat–Thu, 10am–8pm' }),
    logoImageId: z.number().int().positive().nullable().default(null).meta({ description: 'Id from POST /v1/admin/media' }),
    facebook: link.default(null),
    instagram: link.default(null),
    youtube: link.default(null),
    tiktok: link.default(null),
  })
  .meta({ id: 'StoreSettings' });

export type StoreSettings = z.infer<typeof storeSettings>;

// ---- Checkout: cash on delivery and wholesale terms ----

export const WHOLESALE_DELIVERY = ['retail', 'fixed', 'free', 'paid_on_delivery'] as const;

export const checkoutSettings = z
  .object({
    cod: z
      .object({
        enabled: z.boolean().default(true),
        maxAmount: money('limit').nullable().default(null).meta({ description: 'Bigger orders must be paid online. null = no limit.' }),
      })
      .default({ enabled: true, maxAmount: null }),
    wholesale: z
      .object({
        advancePercent: z
          .number({ error: 'Enter the advance' })
          .min(0, { error: 'The advance cannot be negative' })
          .max(100, { error: 'The advance cannot be more than 100%' })
          .default(5)
          .meta({ description: 'Part of a wholesale order paid before it is sent; the rest is cash on delivery' }),
        minOrderAmount: money('minimum order').nullable().default(null),
        delivery: z.enum(WHOLESALE_DELIVERY).default('retail').meta({
          description:
            'retail: same charges as retail orders; fixed: deliveryFee; free; paid_on_delivery: the customer pays the courier',
        }),
        deliveryFee: money('delivery charge').nullable().default(null),
        terms: optionalText(2000).default(null).meta({ description: 'Shown to business customers at checkout' }),
      })
      .default({ advancePercent: 5, minOrderAmount: null, delivery: 'retail', deliveryFee: null, terms: null })
      .superRefine((w, ctx) => {
        if (w.delivery === 'fixed' && w.deliveryFee === null) {
          ctx.addIssue({ code: 'custom', path: ['deliveryFee'], message: 'Enter the delivery charge' });
        }
      }),
    /** Buy more, pay less per piece (retail). Products can use their own steps or none. */
    bulk: z
      .object({
        enabled: z.boolean().default(false),
        tiers: bulkTiersSchema.default([]).meta({ description: 'e.g. 10 or more: 5% off; 50 or more: 10% off' }),
        onSale: z.boolean().default(true).meta({ description: 'Also on items already on sale' }),
      })
      .default({ enabled: false, tiers: [], onSale: true }),
  })
  .meta({ id: 'CheckoutSettings' });

export type CheckoutSettings = z.infer<typeof checkoutSettings>;

// ---- Messages to customers about their orders ----

/** Order moments a customer can be told about. */
export const MESSAGE_EVENTS = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

const channels = (sms: boolean, email: boolean) =>
  z.object({ sms: z.boolean().default(sms), email: z.boolean().default(email) }).default({ sms, email });

/** Which messages go out. SMS cost money, so only the ones that matter most are on at first. */
export const messagesSettings = z
  .object({
    placed: channels(false, true),
    confirmed: channels(true, true),
    shipped: channels(true, true),
    delivered: channels(false, true),
    cancelled: channels(true, true),
    /** A business account approved (from the website's business sign-up or by staff). */
    businessApproved: channels(true, true),
  })
  .meta({ id: 'MessageSettings' });

export type MessagesSettings = z.infer<typeof messagesSettings>;

export const SETTINGS = { store: storeSettings, checkout: checkoutSettings, messages: messagesSettings } as const;
export type SettingsKey = keyof typeof SETTINGS;

// ---- Delivery zones ----

export const zoneBody = z
  .object({
    name: z.string().trim().min(2, { error: 'Name must be at least 2 characters' }).max(60, { error: 'Name is too long' }),
    fee: money('delivery charge'),
    freeAbove: money('amount').nullable().default(null),
    includedKg: z
      .number({ error: 'Enter the weight' })
      .min(0)
      .max(1000)
      .nullable()
      .default(null)
      .meta({ description: 'Weight included in the fee' }),
    extraPerKg: money('extra charge').nullable().default(null).meta({ description: 'For every started kg above includedKg' }),
    deliveryTime: optionalText(40).default(null).meta({ example: '1–2 days' }),
    districtIds: z.array(z.string()).max(64).default([]),
    areaIds: z.array(z.string()).max(600).default([]),
    isActive: z.boolean().default(true),
  })
  .superRefine((zone, ctx) => {
    if ((zone.includedKg === null) !== (zone.extraPerKg === null)) {
      ctx.addIssue({
        code: 'custom',
        path: [zone.includedKg === null ? 'includedKg' : 'extraPerKg'],
        message: 'Fill in both the included weight and the extra charge, or neither',
      });
    }
  })
  .meta({ id: 'DeliveryZoneBody' });

export type ZoneInput = z.infer<typeof zoneBody>;

export const quoteBody = z
  .object({
    districtId: z.string({ error: 'Choose a district' }).min(1, { error: 'Choose a district' }),
    areaId: z.string().nullable().default(null),
    subtotal: money('order amount').default(0),
    weightKg: z.number().min(0).max(10_000).default(0),
    wholesale: z.boolean().default(false),
  })
  .meta({ id: 'DeliveryQuoteBody' });

// ---- Stock locations ----

export const stockLocationBody = z
  .object({
    name: z.string().trim().min(2, { error: 'Name must be at least 2 characters' }).max(60, { error: 'Name is too long' }),
    isActive: z.boolean().default(true),
  })
  .meta({ id: 'StockLocationBody' });

// ---- Responses (used for docs) ----

export const zoneSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    fee: z.number(),
    freeAbove: z.number().nullable(),
    includedKg: z.number().nullable(),
    extraPerKg: z.number().nullable(),
    deliveryTime: z.string().nullable(),
    districtIds: z.array(z.string()),
    areaIds: z.array(z.string()),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    sortOrder: z.number(),
  })
  .meta({ id: 'DeliveryZone' });

export const quoteSchema = z
  .object({
    zone: z.object({ id: z.number(), name: z.string(), deliveryTime: z.string().nullable() }).nullable(),
    fee: z.number().nullable().meta({ description: 'null: no zone delivers here' }),
    baseFee: z.number(),
    weightFee: z.number(),
    free: z.boolean().meta({ description: 'Free because of the order amount or the wholesale terms' }),
    note: z.string().nullable(),
  })
  .meta({ id: 'DeliveryQuote' });

export const locationsSchema = z
  .object({
    divisions: z.array(z.object({ id: z.string(), name: z.string() })),
    districts: z.array(z.object({ id: z.string(), name: z.string(), divisionId: z.string() })),
    areas: z.array(z.object({ id: z.string(), name: z.string(), districtId: z.string(), city: z.boolean() })),
  })
  .meta({ id: 'BdLocations' });

export const stockLocationSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    units: z.number().meta({ description: 'Stock units kept here (all products)' }),
  })
  .meta({ id: 'StockLocation' });

const text = z.string().nullable();

export const storeSettingsSchema = z
  .object({
    name: z.string(),
    tagline: text,
    phone: text,
    whatsapp: text,
    email: text,
    address: text,
    openingHours: text,
    logoImageId: z.number().nullable(),
    facebook: text,
    instagram: text,
    youtube: text,
    tiktok: text,
  })
  .meta({ id: 'StoreSettingsView' });

export const checkoutSettingsSchema = z
  .object({
    cod: z.object({ enabled: z.boolean(), maxAmount: z.number().nullable() }),
    wholesale: z.object({
      advancePercent: z.number(),
      minOrderAmount: z.number().nullable(),
      delivery: z.enum(WHOLESALE_DELIVERY),
      deliveryFee: z.number().nullable(),
      terms: text,
    }),
    bulk: z.object({ enabled: z.boolean(), tiers: z.array(z.object({ minQuantity: z.number(), percent: z.number() })), onSale: z.boolean() }),
  })
  .meta({ id: 'CheckoutSettingsView' });

export const settingsResponse = z
  .object({ store: storeSettingsSchema, checkout: checkoutSettingsSchema, messages: messagesSettings, logo: mediaSchema.nullable() })
  .meta({ id: 'Settings' });
