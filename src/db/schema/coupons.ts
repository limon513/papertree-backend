import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import type { CouponItems, CouponType } from '../../lib/coupon.ts';
import { adminUsers } from './admin.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

/**
 * Coupon codes ("SCHOOL10"). One per order, retail only. The maths is in lib/coupon.ts; who may use a
 * code and when is checked in the coupons service. A used coupon is never deleted (orders keep it),
 * only switched off.
 */
export const coupons = pgTable('coupons', {
  id: id(),
  /** Upper case, letters and numbers ("SCHOOL10"). Shoppers may type it in any case. */
  code: text('code').notNull().unique(),
  /** For staff: what it is for ("Facebook post, school season"). */
  note: text('note'),
  type: text('type').$type<CouponType>().notNull(),
  /** percent: 0.5–90; fixed: taka; free_delivery: null. */
  value: numeric('value', { precision: 12, scale: 2, mode: 'number' }),
  /** percent: at most this many taka off. */
  maxDiscount: money('max_discount'),
  /** On the items it applies to, after bulk discounts. */
  minOrder: money('min_order'),
  startsAt: timestamptz('starts_at'),
  endsAt: timestamptz('ends_at'),
  /** All customers together. null: no limit. */
  usageLimit: integer('usage_limit'),
  /** Per customer (phone number or account). null: no limit. */
  perCustomerLimit: integer('per_customer_limit').default(1),
  /** Only for a phone number that never ordered before. */
  newCustomersOnly: boolean('new_customers_only').notNull().default(false),
  /** A private coupon: only this phone number ("01712345678"). */
  phone: text('phone'),
  /** Only some items. All empty: every item. */
  items: jsonb('items').$type<CouponItems>().notNull().default(sql`'{"productIds":[],"categoryIds":[],"brandIds":[]}'::jsonb`),
  onSaleItems: boolean('on_sale_items').notNull().default(true),
  withBulk: boolean('with_bulk').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  /** Orders placed with it (cancelled ones too: a use is never given back). Counted while the coupon row is locked. */
  usedCount: integer('used_count').notNull().default(0),
  createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  ...timestamps,
},
(t) => [
  // Last line of defence, whatever the form sends.
  check('coupons_type_value', sql`(${t.type} = 'percent' and ${t.value} > 0 and ${t.value} <= 90) or (${t.type} = 'fixed' and ${t.value} > 0) or (${t.type} = 'free_delivery' and ${t.value} is null)`),
  check('coupons_numbers', sql`${t.usedCount} >= 0 and coalesce(${t.usageLimit}, 1) > 0 and coalesce(${t.perCustomerLimit}, 1) > 0 and coalesce(${t.maxDiscount}, 1) > 0 and coalesce(${t.minOrder}, 0) >= 0`),
]);
