import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { customers, orderEvents, orders, products, quotationItems, quotations } from '../../db/schema/index.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { bdPhone } from '../../lib/phone.ts';
import { logger } from '../../lib/logger.ts';
import { isApprovedBusiness } from '../admin/customers/service.ts';
import { createOrder } from '../admin/orders/service.ts';
import { emailSchema, nameSchema, optionalText } from '../admin/schemas.ts';
import { startPayment } from '../payments/service.ts';
import { onlinePaymentReady } from '../payments/sslcommerz.ts';
import { createQuotation, quotationTotal, quotationWithItems, quoteNumber, shownStatus } from '../quotations/service.ts';
import { currentCustomer, signIn } from './account/session.ts';

/** Quotations on the website. Mounted at /v1/store/quotations. */
export const storeQuotationsRouter = Router();

const limiter = (limit: number, message: string) =>
  rateLimit({ windowMs: 60 * 60 * 1000, limit, skipFailedRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'TOO_MANY_REQUESTS', message } } });
const makeLimiter = limiter(15, 'You have made several quotations already. Please call us for more.');
const orderLimiter = limiter(20, 'Too many orders from this connection. Please call us to order.');

const optional = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().default(null);

export const quotationBody = z
  .object({
    items: z
      .array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().min(1).max(9999) }))
      .min(1, { error: 'Your cart is empty' })
      .max(100),
    name: nameSchema,
    organisation: optional(150),
    phone: bdPhone,
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    note: optional(500),
    /** Left empty by people; bots fill every box. */
    website: z.string().max(200).optional(),
  })
  .meta({ id: 'StoreQuotationBody' });

export const quotationPlaceBody = z.object({ districtId: z.string().min(1, { error: 'Choose your district' }), areaId: z.string().nullable().default(null) }).meta({ id: 'StoreQuotationPlace' });

export const quotationOrderBody = z
  .object({
    name: nameSchema,
    phone: bdPhone,
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    districtId: z.string({ error: 'Choose your district' }).min(1, { error: 'Choose your district' }),
    areaId: z.string().nullable().default(null),
    address: z.string({ error: 'Enter your address' }).trim().min(5, { error: 'Enter the full address (house, road, area)' }).max(500, { error: 'The address is too long' }),
    note: optionalText(1000).default(null),
    paymentMethod: z.enum(['cod', 'online']).default('cod'),
    /** The total the shopper saw (quoted items + delivery): if it differs now, nothing is placed (409 PRICE_CHANGED). */
    expectedTotal: z.number().min(0),
    /** A new id per attempt; the same one again returns the same order. */
    requestId: z.string().min(8).max(64),
    website: z.string().max(200).optional(),
  })
  .meta({ id: 'StoreQuotationOrderBody' });

/** By the secret token in the quotation's link (the only key: no sign-in needed). */
async function byToken(token: string) {
  if (!/^[\w-]{20,40}$/.test(token)) throw notFound('Quotation not found');
  const [q] = await db.select().from(quotations).where(eq(quotations.publicToken, token));
  if (!q) throw notFound('Quotation not found');
  return q;
}

/** Make a quotation from the cart: today's prices (a signed-in business: its wholesale prices). */
storeQuotationsRouter.post('/', makeLimiter, async (req, res) => {
  const { website, ...input } = quotationBody.parse(req.body);
  if (website) {
    res.status(201).json({ number: null, token: null });
    return;
  }
  // Only a signed-in shopper's quotation is theirs (never matched by phone alone).
  const me = await currentCustomer(req);
  const wholesale = !!me && isApprovedBusiness(me);
  const q = await createQuotation(input, { type: wholesale ? 'wholesale' : 'retail', customerId: me?.id ?? null, source: 'website', adminUserId: null });
  res.status(201).json({ number: quoteNumber(q.number), token: q.publicToken });
});

/** The quotation page. */
storeQuotationsRouter.get('/:token', async (req, res) => {
  const q = await byToken(String(req.params.token));
  const view = await quotationWithItems(eq(quotations.id, q.id));
  if (!view) throw notFound('Quotation not found');
  const { quotation: x } = view;
  res.set('cache-control', 'no-store').json({
    number: quoteNumber(x.number),
    status: view.status,
    type: x.type,
    name: x.name,
    organisation: x.organisation,
    phone: x.phone,
    email: x.email,
    note: x.note,
    createdAt: x.createdAt,
    validUntil: x.validUntil,
    subtotal: x.subtotal,
    bulkDiscount: x.bulkDiscount,
    /** Fixed by staff (0 = free); null: worked out when ordering. */
    deliveryFee: x.deliveryFee,
    terms: x.terms,
    /** Replaced by a newer version (staff revised it): its number and link token. */
    replacedBy: view.replacedBy ? { number: quoteNumber(view.replacedBy.number), token: view.replacedBy.publicToken } : null,
    items: view.items.map((i) => ({
      variantId: i.variantId,
      name: i.name,
      variantLabel: i.variantLabel,
      sku: i.sku,
      image: i.image,
      regularPrice: i.regularPrice,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      bulkPercent: i.bulkPercent,
    })),
    /** Once ordered: the order's number and "thank you" link token. */
    order: view.order ? { number: view.order.number, token: view.order.publicToken } : null,
    online: await onlinePaymentReady(),
  });
});

/** The delivery charge and total for ordering it to a place (shown before "Place order"). */
storeQuotationsRouter.post('/:token/total', async (req, res) => {
  const q = await byToken(String(req.params.token));
  res.json(await quotationTotal(q, quotationPlaceBody.parse(req.body)));
});

const placed = (o: { number: number; publicToken: string | null; total: number }, pay?: { url?: string; error?: string }) => ({
  number: o.number,
  token: o.publicToken,
  total: o.total,
  ...(pay?.url && { payUrl: pay.url }),
  ...(pay?.error && { payError: pay.error }),
});

/**
 * Order the quotation, at its prices, while it is valid. Money path: prices and quantities come from
 * the saved quotation only (never the browser); the quotation is locked and marked ordered in the same
 * transaction as the order, so it is ordered at most once; stock is checked as for any order.
 */
storeQuotationsRouter.post('/:token/order', orderLimiter, async (req, res) => {
  const { website, requestId, expectedTotal, name, phone, email, note, paymentMethod, ...place } = quotationOrderBody.parse(req.body);
  const token = String(req.params.token);
  if (website) {
    res.status(201).json({ number: 0, token: null, total: 0 });
    return;
  }
  const again = async () => {
    const [o] = await db.select({ number: orders.number, publicToken: orders.publicToken, total: orders.total }).from(orders).where(eq(orders.requestId, requestId));
    return o ?? null;
  };
  // The same attempt again (double tap, dropped connection): the order already placed.
  const before = await again();
  if (before) {
    res.json(placed(before));
    return;
  }
  const me = await currentCustomer(req);
  if (paymentMethod === 'online' && !(await onlinePaymentReady())) throw badRequest('Online payment is not available right now. Please choose cash on delivery.');

  let order: Awaited<ReturnType<typeof createOrder>>;
  let quoteNo = '';
  try {
    order = await db.transaction(async (tx) => {
      const [q] = await tx.select().from(quotations).where(eq(quotations.publicToken, /^[\w-]{20,40}$/.test(token) ? token : '-')).for('update');
      if (!q) throw notFound('Quotation not found');
      quoteNo = quoteNumber(q.number);
      if (q.status === 'ordered') throw conflict('This quotation is already ordered.');
      if (q.status === 'cancelled') throw badRequest('This quotation was cancelled. Please ask us for a new one.');
      if (q.status === 'replaced') throw badRequest('This quotation was updated. Please order the new version (see the link at the top of the page).');
      if (shownStatus(q) === 'expired') throw new AppError(410, 'EXPIRED', 'This quotation has expired. Get a new one at today’s prices.');

      // Whose order: the quotation's customer, else the signed-in shopper, else found by phone.
      const customerId = q.customerId ?? me?.id ?? null;
      const [owner] = customerId ? await tx.select().from(customers).where(eq(customers.id, customerId)) : await tx.select().from(customers).where(eq(customers.phone, phone));
      if (owner?.isBlocked) throw forbidden('We cannot take this order on the website. Please call us to order.');
      // Wholesale prices only while the business is still approved.
      if (q.type === 'wholesale' && (!q.customerId || !isApprovedBusiness(owner))) throw badRequest('This wholesale quotation can no longer be ordered online. Please call us.');

      const items = await tx.select().from(quotationItems).where(eq(quotationItems.quotationId, q.id));
      if (!items.length || items.some((i) => i.variantId === null || i.productId === null)) {
        throw badRequest('A product in this quotation no longer exists. Please ask us for a new quotation.');
      }
      const live = await tx.select({ id: products.id, name: products.name, status: products.status }).from(products).where(inArray(products.id, items.map((i) => i.productId!)));
      const gone = live.find((p) => p.status !== 'active') ?? (live.length < new Set(items.map((i) => i.productId)).size ? { name: 'A product' } : null);
      if (gone) throw badRequest(`${gone.name} is no longer for sale. Please ask us for a new quotation.`);

      const made = await createOrder(
        {
          type: q.type,
          channel: 'website',
          paymentMethod,
          customer: { name, phone, email },
          ...place,
          // The quoted price per piece (bulk discounts already in it): no further discounts, no coupons.
          items: items.map((i) => ({
            variantId: i.variantId!,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            bulk: false,
            fixed: { lineTotal: i.lineTotal, bulkPercent: i.bulkPercent, bulkDiscount: i.bulkDiscount },
          })),
          discount: 0,
          // Delivery fixed on the quotation by staff (0 = free); else the zone's charge now.
          deliveryFee: q.deliveryFee,
          customerNote: note,
          staffNote: null,
          couponCode: null,
        },
        null,
        // The wholesale minimum holds for quotations made on the website; staff may agree less.
        { expectedTotal, requestId, publicToken: randomBytes(18).toString('base64url'), customerId: customerId ?? undefined, enforceMinimum: q.type === 'wholesale' && q.source === 'website' },
        tx,
      );
      await tx.update(quotations).set({ status: 'ordered', orderId: made.id, orderedAt: new Date(), updatedAt: new Date() }).where(eq(quotations.id, q.id));
      await tx.insert(orderEvents).values({ orderId: made.id, type: 'note', message: `From quotation ${quoteNumber(q.number)} (quoted prices)`, adminUserId: null });
      return made;
    });
  } catch (err) {
    // Two copies of the same attempt at the same moment: one won, return it.
    const winner = await again();
    if (winner) {
      res.json(placed(winner));
      return;
    }
    throw err;
  }

  if (!me && order.newCustomer) await signIn(res, req, order.customerId, 'order');
  let pay: { url?: string; error?: string } | undefined;
  if (paymentMethod === 'online') {
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    pay = await startPayment(row!).then(
      (p) => ({ url: p.url }),
      (err: Error) => ({ error: err.message }),
    );
  }
  res.status(201).json(placed(order, pay));
  logger.info({ order: order.number, quotation: quoteNo }, 'Order from a quotation');
  sendJob(QUEUES.orderPlaced, { orderId: order.id }, paymentMethod === 'online' ? { startAfter: 180 } : {}).catch((err) => logger.error({ err, order: order.number }, 'Could not queue the order emails'));
  sendJob(QUEUES.courierCheck, { phone }).catch((err) => logger.error({ err, order: order.number }, 'Could not queue the courier check'));
});

