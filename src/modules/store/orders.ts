import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { deliveryZones, orderItems, orders } from '../../db/schema/index.ts';
import { notFound } from '../../lib/errors.ts';
import { createOrder } from '../admin/orders/service.ts';
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
  const { website, requestId, expectedTotal, name, phone, email, note, paymentMethod, ...rest } = checkoutBody.parse(req.body);
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
      },
      null,
      { expectedTotal, requestId, publicToken: randomBytes(18).toString('base64url') },
    );
    res.status(201).json(placed(order));
  } catch (err) {
    // Two copies of the same attempt at the same moment: one won, return it.
    const winner = await byRequest(requestId);
    if (winner) {
      res.json(placed(winner));
      return;
    }
    throw err;
  }
});

/** The shopper's order, for the "thank you" page. The token in the link is the only key: no sign-in. */
storeOrdersRouter.get('/:token', async (req, res) => {
  const token = String(req.params.token);
  if (!/^[\w-]{20,40}$/.test(token)) throw notFound('Order not found');
  const [order] = await db
    .select({ order: orders, deliveryTime: deliveryZones.deliveryTime })
    .from(orders)
    .leftJoin(deliveryZones, eq(deliveryZones.id, orders.deliveryZoneId))
    .where(eq(orders.publicToken, token));
  if (!order) throw notFound('Order not found');
  const o = order.order;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(asc(orderItems.position));
  const images = await imagesById(items.map((i) => i.imageId));
  res.set('cache-control', 'no-store').json({
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
      name: i.name,
      variantLabel: i.variantLabel,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      image: i.imageId ? (images.get(i.imageId) ?? null) : null,
    })),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
  });
});
