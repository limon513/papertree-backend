import { sql } from 'drizzle-orm';
import { check, index, jsonb, numeric, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { orderPayments, orders } from './orders.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

export const ONLINE_PAYMENT_STATUSES = [
  /** Sent to the payment page; no answer yet. */
  'started',
  /** Paid and checked with SSLCommerz; the payment is on the order. */
  'paid',
  /** The shopper's payment did not go through (or they left the payment page). */
  'failed',
  'cancelled',
  /** SSLCommerz says it was paid, but not the amount or currency asked: never counted, staff check. */
  'mismatch',
  /** The payment page could not be opened (SSLCommerz said no). */
  'error',
] as const;
export type OnlinePaymentStatus = (typeof ONLINE_PAYMENT_STATUSES)[number];

/**
 * Each try to pay an order online (SSLCommerz: bKash, Nagad, cards…). A new try gets a new
 * transaction id. Only a try that SSLCommerz confirms (validation API: right order, amount and
 * currency) becomes a payment on the order, and only once (payment_id is unique).
 */
export const onlinePayments = pgTable(
  'online_payments',
  {
    id: id(),
    orderId: ref('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Our id for the try, sent to SSLCommerz as tran_id: "PT100045-3f9a1c2b7e". */
    tranId: text('tran_id').notNull(),
    /** What was asked, in taka. */
    amount: numeric('amount', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('BDT'),
    status: text('status').$type<OnlinePaymentStatus>().notNull().default('started'),
    /** Sandbox (test money) or live. */
    sandbox: text('sandbox').$type<'true' | 'false'>().notNull(),
    sessionKey: text('session_key'),
    /** SSLCommerz's ids once paid: its validation id and the bank's transaction id. */
    valId: text('val_id'),
    bankTranId: text('bank_tran_id'),
    /** How it was paid: "BKASH-BKash", "VISA-Dutch Bangla"… */
    cardType: text('card_type'),
    /** "1": SSLCommerz thinks it is risky (check before sending); "0": fine. */
    riskLevel: text('risk_level'),
    /** Why it failed, in SSLCommerz's words. */
    reason: text('reason'),
    /** The payment it became on the order. */
    paymentId: ref('payment_id').references(() => orderPayments.id, { onDelete: 'set null' }),
    /** What SSLCommerz said when it was checked (no passwords): for staff and support. */
    details: jsonb('details'),
    paidAt: timestamptz('paid_at'),
    /** When it was last asked from SSLCommerz (so the thank-you page does not ask on every visit). */
    checkedAt: timestamptz('checked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('online_payments_tran_id_idx').on(t.tranId),
    uniqueIndex('online_payments_payment_id_idx').on(t.paymentId).where(sql`${t.paymentId} is not null`),
    index('online_payments_order_id_idx').on(t.orderId, t.createdAt),
    index('online_payments_started_idx').on(t.createdAt).where(sql`${t.status} = 'started'`),
    check('online_payments_amount_positive', sql`${t.amount} > 0`),
  ],
);
