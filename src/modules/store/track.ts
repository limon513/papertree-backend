import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { orderEvents, orderItems, orders } from '../../db/schema/index.ts';
import { notFound } from '../../lib/errors.ts';
import { bdPhone } from '../../lib/phone.ts';
import { parcelSteps, type ParcelStep } from '../admin/orders/steadfast.ts';

/**
 * "Track your order": the order number and the phone it was placed with. Shows where the order is
 * and, once it is with Steadfast, every step of the parcel's journey. No address or items: only what
 * someone who knows both can be trusted with.
 */

/** Where the parcel is, in the customer's words. */
const PARCEL_WORDS: Record<string, string> = {
  sending: 'Being handed to the courier',
  in_review: 'Booked with the courier',
  pending: 'With the courier, on the way',
  hold: 'On hold at the courier: we will call you',
  delivered_approval_pending: 'Delivered',
  partial_delivered_approval_pending: 'Partly delivered',
  cancelled_approval_pending: 'Delivery cancelled',
  unknown_approval_pending: 'With the courier',
  delivered: 'Delivered',
  partial_delivered: 'Partly delivered',
  cancelled: 'Delivery cancelled: the parcel is coming back to us',
  exceptional: 'Delayed at the courier: we will call you',
  unknown: 'With the courier',
};

type Order = typeof orders.$inferSelect;

/**
 * The parcel's journey, newest first: asked from Steadfast (kept a minute), else the steps Steadfast
 * already sent us. Empty before the order is handed to the courier.
 */
export async function journeyOf(o: Pick<Order, 'id' | 'number' | 'consignmentId'>): Promise<ParcelStep[]> {
  if (!o.consignmentId) return [];
  const live = await parcelSteps(o.number);
  if (live?.length) return live;
  const saved = await db
    .select({ message: orderEvents.message, at: orderEvents.createdAt })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, o.id), eq(orderEvents.type, 'courier'), isNull(orderEvents.adminUserId), like(orderEvents.message, 'Steadfast: %')))
    .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
    .limit(30);
  return saved.map((e) => ({ text: e.message.replace(/^Steadfast: /, ''), at: e.at.toISOString() }));
}

/** The courier part of an order, as customers see it. */
export async function courierView(o: Order) {
  return {
    courier: o.courier,
    trackingCode: o.trackingCode,
    /** The courier's own tracking page. */
    trackingUrl: o.trackingUrl,
    /** Where the parcel is, in words (null before it is handed over). */
    parcelStatus: o.courierStatus ? (PARCEL_WORDS[o.courierStatus] ?? 'With the courier') : null,
    /** Steps of the parcel's journey, newest first. */
    journey: await journeyOf(o),
  };
}

export const trackBody = z
  .object({
    number: z.coerce
      .number({ error: 'Enter the order number' })
      .int({ error: 'Enter the order number' })
      .positive({ error: 'Enter the order number' })
      .max(999_999_999, { error: 'Enter the order number' })
      .meta({ description: 'The order number, e.g. 100036 (a leading # is fine)' }),
    phone: bdPhone,
  })
  .meta({ id: 'StoreTrackBody' });

export const trackRouter = Router();

// Enough for anyone looking up their own orders; too few to guess others'.
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

trackRouter.post('/track', limiter, async (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const input = trackBody.parse({ ...raw, number: typeof raw.number === 'string' ? raw.number.replace(/^\s*#/, '').trim() : raw.number });
  const [o] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.number, input.number), eq(orders.phone, input.phone)));
  // The same answer for a wrong number and a wrong phone: nothing to learn by guessing.
  if (!o) throw notFound('We could not find an order with this number and phone. Check both, or call us.');
  const count = (await db.select({ q: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, o.id))).reduce((n, i) => n + i.q, 0);
  const due = Math.max(0, Math.round((o.total - o.paidAmount) * 100) / 100);
  res.set('cache-control', 'no-store').json({
    number: o.number,
    status: o.status,
    type: o.type,
    placedAt: o.createdAt,
    confirmedAt: o.confirmedAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    /** Area and district only. */
    place: [o.areaName, o.districtName].filter(Boolean).join(', '),
    itemCount: count,
    total: o.total,
    /** Still to pay (cash on delivery). */
    due: o.status === 'cancelled' || o.status === 'returned' ? 0 : due,
    ...(await courierView(o)),
  });
});
