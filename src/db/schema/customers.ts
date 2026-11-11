import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

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
    /** Their Google account (Firebase user id), once they signed in with Google. */
    googleId: text('google_id').unique(),
    /** Their Google account photo: only the address, shown straight from Google (nothing stored here). */
    avatarUrl: text('avatar_url'),
    lastSignInAt: timestamptz('last_sign_in_at'),
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

/** A signed-in customer on the website. The id is the SHA-256 of the cookie token (the token is never stored). */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: text('id').primaryKey(),
    customerId: ref('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /**
     * How they signed in. 'order' = signed in by placing their first order (the phone was not checked):
     * such sessions end when someone confirms the phone with a code.
     */
    via: text('via').$type<'code' | 'google' | 'order'>().notNull().default('code'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamptz('expires_at').notNull(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('customer_sessions_customer_id_idx').on(t.customerId)],
);

/**
 * One-time sign-in codes sent by SMS. Only a hash is stored; a code works once, for 5 minutes,
 * with a few tries.
 */
export const customerLoginCodes = pgTable(
  'customer_login_codes',
  {
    id: id(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    ip: text('ip'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('customer_login_codes_phone_idx').on(t.phone, t.createdAt)],
);
