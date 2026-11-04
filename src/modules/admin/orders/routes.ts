import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { adminUsers, customers, orderEvents, orderItems, orderPayments, orders, products, productVariants } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { parseId } from '../../../lib/ids.ts';
import { normalizePhone } from '../../../lib/phone.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { withImages } from '../media/view.ts';
import { quoteBody } from '../settings/schemas.ts';
import { DISTRICTS, getSettings, listZones, quote } from '../settings/service.ts';
import {
  courierBody,
  customerLookupQuery,
  noteBody,
  orderBody,
  orderListQuery,
  paymentBody,
  STATUS_FLOW,
  statusBody,
  variantSearchQuery,
} from './schemas.ts';
import {
  addNote,
  addPayment,
  createOrder,
  defaultLocationId,
  EDITABLE,
  loadVariants,
  retailPrice,
  setCourier,
  setStatus,
  updateOrder,
  variantLabel,
} from './service.ts';

/** Mounted behind requireAdmin + requireModule('orders'). */
export const ordersRouter = Router();

const PAGE_SIZE = 50;
const CLOSED = ['delivered', 'cancelled', 'returned'] as const;

ordersRouter.get('/', async (req, res) => {
  const q = orderListQuery.parse(req.query);

  const search = q.search?.replace(/^#/, '');
  const filters: (SQL | undefined)[] = [
    search
      ? or(
          /^\d{6,7}$/.test(search) ? eq(orders.number, Number(search)) : undefined,
          ilike(orders.phone, `%${normalizePhone(search)}%`),
          ilike(orders.customerName, `%${search}%`),
        )
      : undefined,
    q.payment ? eq(orders.paymentStatus, q.payment) : undefined,
    q.channel ? eq(orders.channel, q.channel) : undefined,
    q.type ? eq(orders.type, q.type) : undefined,
    // Dates are Bangladesh days.
    q.from ? gte(orders.createdAt, new Date(`${q.from}T00:00:00+06:00`)) : undefined,
    q.to ? lt(orders.createdAt, new Date(new Date(`${q.to}T00:00:00+06:00`).getTime() + 86_400_000)) : undefined,
  ];
  const statusFilter =
    q.status === 'open' ? notInArray(orders.status, [...CLOSED]) : q.status ? eq(orders.status, q.status) : undefined;
  const where = and(...filters, statusFilter);

  const [rows, [total], counts] = await Promise.all([
    db
      .select({
        id: orders.id,
        number: orders.number,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        channel: orders.channel,
        type: orders.type,
        customerName: orders.customerName,
        phone: orders.phone,
        districtName: orders.districtName,
        areaName: orders.areaName,
        // Table names spelled out: inside the subquery a bare "id" would be order_items.id.
        items: sql<number>`(select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = "orders"."id")`.mapWith(Number),
        total: orders.total,
        paidAmount: orders.paidAmount,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(orders).where(where),
    db
      .select({ status: orders.status, n: count() })
      .from(orders)
      .where(and(...filters))
      .groupBy(orders.status),
  ]);

  const byStatus: Record<string, number> = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  byStatus.open = counts.filter((c) => !(CLOSED as readonly string[]).includes(c.status)).reduce((s, c) => s + c.n, 0);
  byStatus.all = counts.reduce((s, c) => s + c.n, 0);
  res.json({ items: rows, total: total?.n ?? 0, page: q.page, pageSize: PAGE_SIZE, counts: byStatus });
});

/** Products to add to an order: name or SKU search, with today's price and stock. */
ordersRouter.get('/variant-search', async (req, res) => {
  const q = variantSearchQuery.parse(req.query);
  const locationId = q.locationId ?? (await defaultLocationId());
  const words = q.q.split(/\s+/).filter(Boolean);
  const ids = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        ne(products.status, 'archived'),
        ...words.map((w) =>
          or(
            ilike(products.name, `%${w}%`),
            ilike(productVariants.sku, `%${w}%`),
            ilike(productVariants.option1, `%${w}%`),
            ilike(productVariants.option2, `%${w}%`),
          ),
        ),
      ),
    )
    .orderBy(desc(products.updatedAt), asc(productVariants.position))
    .limit(30);

  const variants = await loadVariants(db, ids.map((r) => r.id), locationId);
  const order = new Map(ids.map((r, i) => [r.id, i]));
  variants.sort((a, b) => order.get(a.variantId)! - order.get(b.variantId)!);
  const withImg = await withImages(variants);
  res.json({
    items: withImg.map((v) => ({
      variantId: v.variantId,
      productId: v.productId,
      name: v.name,
      variantLabel: variantLabel(v),
      sku: v.sku,
      status: v.status,
      image: v.image,
      price: retailPrice(v),
      regularPrice: v.price,
      wholesalePrice: v.wholesalePrice,
      weightGrams: v.weightGrams,
      trackStock: v.trackStock,
      allowBackorder: v.allowBackorder,
      stock: v.stock,
    })),
  });
});

/** The delivery charge for the order being entered (same rules as the checkout). */
ordersRouter.post('/delivery-quote', async (req, res) => {
  const input = quoteBody.parse(req.body);
  if (!DISTRICTS.has(input.districtId)) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  const [zones, checkout] = await Promise.all([listZones(), getSettings('checkout')]);
  res.json(quote(zones, checkout, input));
});

/** The customer with this phone number and their last address, to fill in a new order. */
ordersRouter.get('/customer-lookup', async (req, res) => {
  const phone = normalizePhone(customerLookupQuery.parse(req.query).phone);
  const [[customer], [last], [n]] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email, type: customers.type })
      .from(customers)
      .where(eq(customers.phone, phone)),
    db
      .select({ districtId: orders.districtId, areaId: orders.areaId, address: orders.address })
      .from(orders)
      .where(eq(orders.phone, phone))
      .orderBy(desc(orders.createdAt))
      .limit(1),
    db.select({ n: count() }).from(orders).where(eq(orders.phone, phone)),
  ]);
  res.json({ customer: customer ?? null, orders: n?.n ?? 0, lastAddress: last ?? null });
});

async function orderView(id: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) throw notFound('Order not found');

  const [items, payments, events, customer] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(asc(orderItems.position)),
    db
      .select({
        id: orderPayments.id,
        method: orderPayments.method,
        amount: orderPayments.amount,
        reference: orderPayments.reference,
        note: orderPayments.note,
        by: adminUsers.name,
        createdAt: orderPayments.createdAt,
      })
      .from(orderPayments)
      .leftJoin(adminUsers, eq(adminUsers.id, orderPayments.createdBy))
      .where(eq(orderPayments.orderId, id))
      .orderBy(asc(orderPayments.createdAt)),
    db
      .select({ id: orderEvents.id, type: orderEvents.type, message: orderEvents.message, by: adminUsers.name, createdAt: orderEvents.createdAt })
      .from(orderEvents)
      .leftJoin(adminUsers, eq(adminUsers.id, orderEvents.adminUserId))
      .where(eq(orderEvents.orderId, id))
      .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id)),
    order.customerId
      ? db
          .select({
            id: customers.id,
            type: customers.type,
            orders: sql<number>`(select count(*) from orders o where o.customer_id = "customers"."id")`.mapWith(Number),
          })
          .from(customers)
          .where(eq(customers.id, order.customerId))
      : Promise.resolve([]),
  ]);

  const [createdBy] = order.createdBy
    ? await db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, order.createdBy))
    : [];
  return {
    ...order,
    createdByName: createdBy?.name ?? null,
    nextStatuses: STATUS_FLOW[order.status],
    canEdit: EDITABLE.includes(order.status),
    items: (await withImages(items)).map(({ imageId: _imageId, stockTaken: _stockTaken, orderId: _orderId, ...i }) => i),
    payments,
    events,
    customer: customer[0] ?? null,
  };
}

ordersRouter.get('/:id', async (req, res) => {
  res.json(await orderView(parseId(req.params.id)));
});

ordersRouter.post('/', async (req, res) => {
  const input = orderBody.parse(req.body);
  const admin = currentAdmin(req);
  const order = await createOrder(input, admin.id);
  await audit(req, { action: 'order.create', entityType: 'order', entityId: order.id, after: { number: order.number } });
  res.status(201).json(await orderView(order.id));
});

ordersRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const input = orderBody.parse(req.body);
  await updateOrder(id, input, currentAdmin(req).id);
  await audit(req, { action: 'order.update', entityType: 'order', entityId: id });
  res.json(await orderView(id));
});

ordersRouter.post('/:id/status', async (req, res) => {
  const id = parseId(req.params.id);
  const input = statusBody.parse(req.body);
  await setStatus(id, input, currentAdmin(req).id);
  await audit(req, { action: 'order.status', entityType: 'order', entityId: id, after: { status: input.status } });
  res.json(await orderView(id));
});

ordersRouter.post('/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  const input = paymentBody.parse(req.body);
  await addPayment(id, input, currentAdmin(req).id);
  await audit(req, { action: 'order.payment', entityType: 'order', entityId: id, after: input });
  res.json(await orderView(id));
});

ordersRouter.post('/:id/notes', async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = noteBody.parse(req.body);
  await addNote(id, note, currentAdmin(req).id);
  res.json(await orderView(id));
});

ordersRouter.put('/:id/courier', async (req, res) => {
  const id = parseId(req.params.id);
  const input = courierBody.parse(req.body);
  await setCourier(id, input.courier, input.trackingCode, currentAdmin(req).id);
  res.json(await orderView(id));
});

