import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { customers, deliveryZones, onlinePayments, orderEvents, orderItems, orders } from '../../db/schema/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { logger } from '../../lib/logger.ts';
import { codeGuard, CouponError, tooManyTries } from '../admin/coupons/service.ts';
import { createOrder } from '../admin/orders/service.ts';
import { actingStaff, currentCustomer, signIn } from './account/session.ts';
import { imagesById } from './catalog.ts';
import { isApprovedBusiness } from '../admin/customers/service.ts';
import { getSettings } from '../admin/settings/service.ts';
import { checkoutBody } from './schemas.ts';
import { courierView } from './track.ts';
import { systemNote } from '../admin/orders/service.ts';
import { latestTry, MIN_ONLINE, onlineAmount, startPayment } from '../payments/service.ts';
import { onlinePaymentReady } from '../payments/sslcommerz.ts';

/** Orders from the website. Mounted at /v1/store/orders. */
export const storeOrdersRouter = Router();

/**
 * Orders per visitor per hour. Many shoppers in Bangladesh share one mobile network address, so the
 * limit is generous, and only placed orders count (a mistyped phone number is not held against anyone).
 */
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many orders from this connection. Please call us to order.' } },
});

const placed = (o: { number: number; publicToken: string | null; total: number }, pay?: { url?: string; error?: string }) => ({
  number: o.number,
  token: o.publicToken,
  total: o.total,
  /** Paying online: the payment page to go to now, or why it could not open (the order is placed either way). */
  ...(pay?.url && { payUrl: pay.url }),
  ...(pay?.error && { payError: pay.error }),
});

/** Paying online, a few tries per visitor: plenty for people, not for someone hammering SSLCommerz. */
const payLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many tries. Please wait a few minutes, or choose cash on delivery.' } },
});

/** An order by the secret token in the shopper's "thank you" link. */
async function byToken(token: string) {
  if (!/^[\w-]{20,40}$/.test(token)) throw notFound('Order not found');
  const [o] = await db.select().from(orders).where(eq(orders.publicToken, token));
  if (!o) throw notFound('Order not found');
  return o;
}

async function byRequest(requestId: string) {
  const [o] = await db.select({ number: orders.number, publicToken: orders.publicToken, total: orders.total }).from(orders).where(eq(orders.requestId, requestId));
  return o ?? null;
}

/**
 * Place an order (cash on delivery). Prices, stock and the delivery charge are worked out here, never
 * taken from the browser. The customer is found by phone number, or added, and the address saved.
 */
storeOrdersRouter.post('/', orderLimiter, async (req, res) => {
  const { website, requestId, expectedTotal, name, phone, email, note, paymentMethod, couponCode, ...rest } = checkoutBody.parse(req.body);
  // The hidden box was filled: a bot. Answer as if placed, so it does not try again.
  if (website) {
    res.status(201).json({ number: 0, token: null, total: 0 });
    return;
  }
  // The same attempt again (double tap, or a retry after a dropped connection): the order already placed.
  const again = await byRequest(requestId);
  if (again) {
    res.json(placed(again));
    return;
  }
  // A signed-in shopper's order is theirs, whatever phone they give for this delivery.
  const me = await currentCustomer(req);
  // A staff member logged in as the customer: the order is marked as entered by them.
  const staff = me ? await actingStaff(req) : null;
  const [byPhone] = me ? [] : await db.select({ isBlocked: customers.isBlocked }).from(customers).where(eq(customers.phone, phone));
  if (byPhone?.isBlocked) throw forbidden('We cannot take this order on the website. Please call us to order.');
  // Too many wrong codes from this connection: codes are not even looked up for a while.
  if (couponCode && !codeGuard.allowed(req.ip)) throw tooManyTries();
  // An approved business (signed in) orders at wholesale prices and terms; everyone else retail.
  const wholesale = !!me && isApprovedBusiness(me);
  // Paying online only when the shop has it on (checked before the order is made).
  if (paymentMethod === 'online' && !(await onlinePaymentReady())) throw badRequest('Online payment is not available right now. Please choose cash on delivery.');
  try {
    const order = await createOrder(
      {
        ...rest,
        type: wholesale ? 'wholesale' : 'retail',
        channel: 'website',
        paymentMethod,
        customer: { name, phone, email },
        discount: 0,
        deliveryFee: null,
        customerNote: note,
        staffNote: null,
        couponCode: couponCode || null,
      },
      staff?.id ?? null,
      { expectedTotal, requestId, publicToken: randomBytes(18).toString('base64url'), customerId: me?.id, enforceMinimum: wholesale, onlyForSale: true },
    );
    if (staff) await db.insert(orderEvents).values({ orderId: order.id, type: 'note', message: `Placed on the website by ${staff.name}, logged in as the customer`, adminUserId: staff.id });
    // A first order from a new number signs them in, so the next order is quicker. Such a sign-in ends
    // as soon as someone confirms that number with a code.
    if (!me && order.newCustomer) await signIn(res, req, order.customerId, 'order');
    // Paying online: the payment page opens now. If it cannot, the order stays (pay later, or cash on delivery).
    let pay: { url?: string; error?: string } | undefined;
    if (paymentMethod === 'online') {
      const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
      pay = await startPayment(row!).then(
        (p) => ({ url: p.url }),
        (err: Error) => ({ error: err.message }),
      );
    }
    res.status(201).json(placed(order, pay));
    // Emails go out in the background: the shopper never waits for them, and a failure never undoes the order.
    // Paying online: a few minutes later, so the emails can say whether it is paid.
    sendJob(QUEUES.orderPlaced, { orderId: order.id }, paymentMethod === 'online' ? { startAfter: 180 } : {}).catch((err) => logger.error({ err, order: order.number }, 'Could not queue the order emails'));
    // Cash on delivery: the customer's courier record, for staff to see before confirming.
    sendJob(QUEUES.courierCheck, { phone }).catch((err) => logger.error({ err, order: order.number }, 'Could not queue the courier check'));
  } catch (err) {
    if (err instanceof CouponError && err.reason === 'unknown') codeGuard.failed(req.ip);
    // Two copies of the same attempt at the same moment: one won, return it.
    const winner = await byRequest(requestId);
    if (winner) {
      res.json(placed(winner));
      return;
    }
    throw err;
  }
});

/** An order as the shopper sees it. */
export async function orderView(where: SQL) {
  const [order] = await db
    .select({ order: orders, deliveryTime: deliveryZones.deliveryTime })
    .from(orders)
    .leftJoin(deliveryZones, eq(deliveryZones.id, orders.deliveryZoneId))
    .where(where);
  if (!order) return null;
  const o = order.order;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(asc(orderItems.position));
  const [images, checkout] = await Promise.all([imagesById(items.map((i) => i.imageId)), o.type === 'wholesale' ? getSettings('checkout') : null]);
  return {
    number: o.number,
    status: o.status,
    /** wholesale: a business order (advance, then the rest on delivery). */
    type: o.type,
    /** Wholesale: to pay before it is sent. */
    advanceRequired: o.advanceRequired,
    paidAmount: o.paidAmount,
    /** Wholesale: how to pay the advance (bKash / Nagad numbers). */
    payAdvance: checkout?.wholesale.payAdvance ?? null,
    createdAt: o.createdAt,
    customerName: o.customerName,
    phone: o.phone,
    address: o.address,
    areaName: o.areaName,
    districtName: o.districtName,
    deliveryTime: order.deliveryTime,
    paymentMethod: o.paymentMethod,
    /** Courier, tracking code and link, where the parcel is, its journey. */
    ...(await courierView(o)),
    items: items.map((i) => ({
      // For "Order again" (null when the product was deleted).
      variantId: i.variantId,
      name: i.name,
      variantLabel: i.variantLabel,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      bulkPercent: i.bulkPercent,
      image: i.imageId ? (images.get(i.imageId) ?? null) : null,
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    bulkDiscount: o.bulkDiscount,
    couponCode: o.couponCode,
    couponDiscount: o.couponDiscount,
    deliveryFee: o.deliveryFee,
    total: o.total,
  };
}

/** The shopper's order, for the "thank you" page. The token in the link is the only key: no sign-in. */
storeOrdersRouter.get('/:token', async (req, res) => {
  const o = await byToken(String(req.params.token));
  // A payment still waiting for an answer is looked up first (it may have just been paid).
  const [last, ready] = await Promise.all([latestTry(o.id), onlinePaymentReady()]);
  const [now] = await db.select().from(orders).where(eq(orders.id, o.id));
  const view = await orderView(eq(orders.id, o.id));
  if (!view || !now) throw notFound('Order not found');
  const amount = onlineAmount(now);
  res.set('cache-control', 'no-store').json({
    ...view,
    paymentStatus: now.paymentStatus,
    /** Paying online: can it be paid now (and how much), and the latest try. */
    online: { available: ready && amount >= MIN_ONLINE, amount, lastTry: last },
  });
});

/** Pay the order online now (a new try): answers the payment page to go to. */
storeOrdersRouter.post('/:token/pay', payLimiter, async (req, res) => {
  const o = await byToken(String(req.params.token));
  const pay = await startPayment(o);
  res.json({ payUrl: pay.url, amount: pay.amount });
});

/** Pay cash on delivery instead of online (only while nothing is paid online). */
storeOrdersRouter.post('/:token/cod', payLimiter, async (req, res) => {
  const o = await byToken(String(req.params.token));
  if (o.paymentMethod === 'cod') {
    res.json({ paymentMethod: 'cod' });
    return;
  }
  if (o.status === 'cancelled' || o.status === 'returned' || o.status === 'delivered') throw conflict('This order cannot be changed any more.');
  await db.transaction(async (tx) => {
    // The order is locked. A payment confirmed at this very moment is still counted afterwards: the order then shows paid.
    const [locked] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
    const [paid] = await tx.select({ id: onlinePayments.id }).from(onlinePayments).where(and(eq(onlinePayments.orderId, o.id), eq(onlinePayments.status, 'paid'))).limit(1);
    if (paid || (locked?.paidAmount ?? 0) > 0) throw conflict('This order is already paid online.');
    await tx.update(orders).set({ paymentMethod: 'cod' }).where(eq(orders.id, o.id));
    await systemNote(tx, o.id, 'The customer chose cash on delivery instead of paying online');
  });
  res.json({ paymentMethod: 'cod' });
});
