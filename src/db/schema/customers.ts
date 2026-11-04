import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, ref, timestamps } from './_helpers.ts';

export type CustomerType = 'retail' | 'business';
/** A business account asks for wholesale prices; staff approve it. */
export type BusinessStatus = 'pending' | 'approved' | 'rejected';
export type WholesaleDeliveryRule = 'retail' | 'fixed' | 'free' | 'paid_on_delivery';

/** A business's own wholesale terms. Empty fields use the shop's terms (Settings > Payments & wholesale). */
export interface WholesaleTerms {
  advancePercent: number | null;
  minOrderAmount: number | null;
  delivery: WholesaleDeliveryRule | null;
  deliveryFee: number | null;
  note: string | null;
}

/**
 * People who order. Found by phone number (the main contact in Bangladesh).
 * Sign-in (OTP, Google, Facebook) comes with the storefront.
 */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    name: text('name').notNull(),
    /** "01712345678". */
    phone: text('phone').notNull().unique(),
    email: text('email'),
    type: text('type').$type<CustomerType>().notNull().default('retail'),
    businessName: text('business_name'),
    businessStatus: text('business_status').$type<BusinessStatus>(),
    tradeLicense: text('trade_license'),
    /** null = the shop's wholesale terms. */
    wholesaleTerms: jsonb('wholesale_terms').$type<WholesaleTerms>(),
    /** Blocked customers cannot order on the website (e.g. fake cash-on-delivery orders). */
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    /** Staff only. */
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    index('customers_name_idx').on(sql`lower(${t.name})`),
    index('customers_business_status_idx').on(t.businessStatus).where(sql`${t.businessStatus} is not null`),
  ],
);

/** Addresses a customer saved (or used), to fill in the next order. */
export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: id(),
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** "Home", "Office", "Shop". */
    label: text('label'),
    /** Who receives it, when not the customer. */
    recipientName: text('recipient_name'),
    recipientPhone: text('recipient_phone'),
    districtId: text('district_id').notNull(),
    areaId: text('area_id'),
    address: text('address').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('customer_addresses_customer_id_idx').on(t.customerId),
    // One default address per customer.
    uniqueIndex('customer_addresses_one_default_idx').on(t.customerId).where(sql`${t.isDefault}`),
  ],
);
