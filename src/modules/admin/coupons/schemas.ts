import { z } from 'zod';
import { COUPON_TYPES } from '../../../lib/coupon.ts';
import { optionalBdPhone } from '../../../lib/phone.ts';
import { optionalText } from '../schemas.ts';

const ids = z.array(z.number().int().positive()).max(500, { error: 'At most 500' }).default([]);
const taka = (label: string) =>
  z
    .number({ error: `Enter the ${label}` })
    .min(0, { error: `The ${label} cannot be negative` })
    .max(10_000_000, { error: `The ${label} is too high` });

export const couponBody = z
  .object({
    code: z
      .string({ error: 'Enter a code' })
      .trim()
      .transform((v) => v.replace(/\s+/g, '').toUpperCase())
      .refine((v) => /^[A-Z0-9]{4,20}$/.test(v), { error: '4 to 20 letters and numbers, no spaces' })
      .meta({ example: 'SCHOOL10' }),
    note: optionalText(300).default(null).meta({ description: 'For staff: what it is for' }),
    type: z.enum(COUPON_TYPES),
    /** percent: 0.5–90; fixed: whole taka; free_delivery: null. */
    value: z.number().nullable().default(null),
    maxDiscount: taka('largest discount').nullable().default(null).meta({ description: 'percent: at most this many taka off' }),
    minOrder: taka('minimum order').nullable().default(null),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    usageLimit: z.number().int({ error: 'A whole number' }).min(1, { error: 'At least 1' }).max(10_000_000).nullable().default(null),
    perCustomerLimit: z.number().int({ error: 'A whole number' }).min(1, { error: 'At least 1' }).max(1000).nullable().default(1),
    newCustomersOnly: z.boolean().default(false),
    phone: optionalBdPhone.default(null).meta({ description: 'A private coupon: only this phone number' }),
    items: z.object({ productIds: ids, categoryIds: ids, brandIds: ids }).default({ productIds: [], categoryIds: [], brandIds: [] }),
    onSaleItems: z.boolean().default(true),
    withBulk: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (c.type === 'percent') {
      if (c.value === null) issue('value', 'Enter the percent');
      else if (c.value < 0.5 || c.value > 90) issue('value', 'Between 0.5% and 90%');
    } else if (c.type === 'fixed') {
      if (c.value === null) issue('value', 'Enter the amount');
      else if (!Number.isInteger(c.value) || c.value < 1) issue('value', 'Whole taka, at least ৳1');
      if (c.maxDiscount !== null) issue('maxDiscount', 'Only for percent coupons');
    } else {
      if (c.value !== null) issue('value', 'Free delivery has no amount');
      if (c.maxDiscount !== null) issue('maxDiscount', 'Only for percent coupons');
    }
    if (c.maxDiscount !== null && c.maxDiscount < 1) issue('maxDiscount', 'At least ৳1');
    if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt)) issue('endsAt', 'Must be after the start');
  })
  .meta({ id: 'CouponBody' });

export type CouponInput = z.infer<typeof couponBody>;

export const couponListQuery = z.object({
  view: z.enum(['all', 'live', 'scheduled', 'ended', 'off']).default('all'),
  search: z.string().trim().max(50).optional(),
});
