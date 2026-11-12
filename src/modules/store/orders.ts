import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { asc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { customers, deliveryZones, orderItems, orders } from '../../db/schema/index.ts';
import { forbidden, notFound } from '../../lib/errors.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { logger } from '../../lib/logger.ts';
import { codeGuard, CouponError, tooManyTries } from '../admin/coupons/service.ts';
import { createOrder } from '../admin/orders/service.ts';
import { currentCustomer, signIn } from './account/session.ts';
import { imagesById } from './catalog.ts';
import { checkoutBody } from './schemas.ts';

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

const placed = (o: { number: number; publicToken: string | null; total: number }) => ({ number: o.number, token: o.publicToken, total: o.total });

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
  const [byPhone] = me ? [] : await db.select({ isBlocked: customers.isBlocked }).from(customers).where(eq(customers.phone, phone));
  if (byPhone?.isBlocked) throw forbidden('We cannot take this order on the website. Please call us to order.');
  // Too many wrong codes from this connection: codes are not even looked up for a while.
  if (couponCode && !codeGuard.allowed(req.ip)) throw tooManyTries();
  try {
    const order = await createOrder(
      {
        ...rest,
        type: 'retail',
        channel: 'website',
        paymentMethod,
        customer: { name, phone, email },
        discount: 0,
        deliveryFee: null,
        customerNote: note,
        staffNote: null,
        couponCode: couponCode || null,
      },
      null,
      { expectedTotal, requestId, publicToken: randomBytes(18).toString('base64url'), customerId: me?.id },
    );
    // A first order from a new number signs them in, so the next order is quicker. Such a sign-in ends
    // as soon as someone confirms that number with a code.
    if (!me && order.newCustomer) await signIn(res, req, order.customerId, 'order');
    res.status(201).json(placed(order));
    // Emails go out in the background: the shopper never waits for them, and a failure never undoes the order.
    sendJob(QUEUES.orderPlaced, { orderId: order.id }).catch((err) => logger.error({ err, order: order.number }, 'Could not queue the order emails'));
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
  const images = await imagesById(items.map((i) => i.imageId));
  return {
    number: o.number,
    status: o.status,
    createdAt: o.createdAt,
    customerName: o.customerName,
    phone: o.phone,
    address: o.address,
    areaName: o.areaName,
    districtName: o.districtName,
    deliveryTime: order.deliveryTime,
    paymentMethod: o.paymentMethod,
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
  const token = String(req.params.token);
  if (!/^[\w-]{20,40}$/.test(token)) throw notFound('Order not found');
  const view = await orderView(eq(orders.publicToken, token));
  if (!view) throw notFound('Order not found');
  res.set('cache-control', 'no-store').json(view);
});
