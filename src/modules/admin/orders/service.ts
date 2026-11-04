import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import {
  customers,
  orderEvents,
  orderItems,
  orderPayments,
  orders,
  products,
  productVariants,
  stockLocations,
  type OrderEventType,
  type OrderStatus,
  type PaymentStatus,
} from '../../../db/schema/index.ts';
import { badRequest, notFound } from '../../../lib/errors.ts';
import { changeStock, type Tx } from '../products/service.ts';
import { AREAS, DISTRICTS, getSettings, listZones, quote } from '../settings/service.ts';
import { STATUS_FLOW, type OrderInput } from './schemas.ts';

const round = (n: number) => Math.round(n * 100) / 100;
const taka = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Orders whose items can still be changed. */
export const EDITABLE: OrderStatus[] = ['pending', 'confirmed'];

/** Statuses where the order's stock is (still) taken. */
const HOLDS_STOCK = (status: OrderStatus) => status !== 'cancelled' && status !== 'returned';

export async function defaultLocationId(tx: Tx | typeof db = db) {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(eq(stockLocations.isActive, true))
    .orderBy(sql`${stockLocations.isDefault} desc`, asc(stockLocations.sortOrder), asc(stockLocations.id))
    .limit(1);
  if (!row) throw badRequest('Add a stock location first (Settings > Stock locations)');
  return row.id;
}

type VariantRow = Awaited<ReturnType<typeof loadVariants>>[number];

/** Variants with their product, first image and stock at a location. */
export async function loadVariants(tx: Tx | typeof db, ids: number[], locationId: number) {
  if (!ids.length) return [];
  return tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      name: products.name,
      status: products.status,
      option1: productVariants.option1,
      option2: productVariants.option2,
      option3: productVariants.option3,
      sku: productVariants.sku,
      price: productVariants.price,
      salePrice: productVariants.salePrice,
      saleStartsAt: productVariants.saleStartsAt,
      saleEndsAt: productVariants.saleEndsAt,
      wholesalePrice: productVariants.wholesalePrice,
      weightGrams: productVariants.weightGrams,
      trackStock: productVariants.trackStock,
      allowBackorder: productVariants.allowBackorder,
      // Table names spelled out, so the subqueries can never pick up the wrong "id".
      imageId: sql<number | null>`coalesce("product_variants"."image_id", (
        select pi.media_id from product_images pi
        where pi.product_id = "products"."id" order by pi.position limit 1))`.mapWith((v) => (v === null ? null : Number(v))),
      stock: sql<number>`coalesce((select il.quantity from inventory_levels il
        where il.variant_id = "product_variants"."id" and il.location_id = ${locationId}), 0)`.mapWith(Number),
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, ids));
}

export const variantLabel = (v: Pick<VariantRow, 'option1' | 'option2' | 'option3'>) =>
  [v.option1, v.option2, v.option3].filter(Boolean).join(' / ') || null;

/** The retail price today: the sale price while the sale runs. */
export function retailPrice(v: Pick<VariantRow, 'price' | 'salePrice' | 'saleStartsAt' | 'saleEndsAt'>, now = new Date()) {
  const onSale =
    v.salePrice !== null &&
    v.salePrice < v.price &&
    (!v.saleStartsAt || v.saleStartsAt <= now) &&
    (!v.saleEndsAt || v.saleEndsAt >= now);
  return onSale ? v.salePrice! : v.price;
}

/**
 * Works out the order from what staff entered: prices, stock, weight, delivery and totals.
 * `heldNow` is the stock this order already holds per variant (when editing), which counts as available.
 */
async function build(tx: Tx, input: OrderInput, locationId: number, heldNow = new Map<number, number>()) {
  const district = DISTRICTS.get(input.districtId);
  if (!district) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  const area = input.areaId ? AREAS.get(input.areaId) : null;
  if (input.areaId && area?.districtId !== input.districtId) {
    throw badRequest('Choose an area in this district', { areaId: 'Choose an area in this district' });
  }

  // The same product twice becomes one line.
  const lines: { variantId: number; quantity: number; unitPrice?: number; index: number }[] = [];
  input.items.forEach((item, index) => {
    const same = lines.find((l) => l.variantId === item.variantId);
    if (same) same.quantity += item.quantity;
    else lines.push({ ...item, index });
  });

  const variants = new Map((await loadVariants(tx, lines.map((l) => l.variantId), locationId)).map((v) => [v.variantId, v]));
  const now = new Date();
  const items = lines.map((line, position) => {
    const v = variants.get(line.variantId);
    if (!v) throw badRequest('A product in the order no longer exists', { [`items.${line.index}.variantId`]: 'This product no longer exists' });
    if (v.trackStock && !v.allowBackorder) {
      const available = v.stock + (heldNow.get(v.variantId) ?? 0);
      if (line.quantity > available) {
        const message = available > 0 ? `Only ${available} in stock` : 'Out of stock';
        throw badRequest(`${v.name}: ${message.toLowerCase()}`, { [`items.${line.index}.quantity`]: message });
      }
    }
    const listPrice = input.type === 'wholesale' ? (v.wholesalePrice ?? retailPrice(v, now)) : retailPrice(v, now);
    const unitPrice = round(line.unitPrice ?? listPrice);
    return {
      variant: v,
      position,
      quantity: line.quantity,
      regularPrice: v.price,
      unitPrice,
      lineTotal: round(unitPrice * line.quantity),
      weightGrams: v.weightGrams,
    };
  });

  const subtotal = round(items.reduce((sum, i) => sum + i.lineTotal, 0));
  if (input.discount > subtotal) throw badRequest('The discount is bigger than the order', { discount: 'More than the order amount' });
  const weightGrams = items.reduce((sum, i) => sum + (i.weightGrams ?? 0) * i.quantity, 0);

  const [zones, checkout] = await Promise.all([listZones(), getSettings('checkout')]);
  const delivery = quote(zones, checkout, {
    districtId: input.districtId,
    areaId: input.areaId,
    subtotal,
    weightKg: weightGrams / 1000,
    wholesale: input.type === 'wholesale',
  });
  const deliveryFee = input.deliveryFee ?? delivery.fee;
  if (deliveryFee === null) {
    throw badRequest('No delivery zone covers this place. Enter the delivery charge.', { deliveryFee: 'Enter the delivery charge' });
  }

  const total = round(subtotal - input.discount + deliveryFee);
  // Whole taka, rounded up.
  const advanceRequired = input.type === 'wholesale' ? Math.ceil((total * checkout.wholesale.advancePercent) / 100) : 0;

  return {
    items,
    values: {
      type: input.type,
      channel: input.channel,
      paymentMethod: input.paymentMethod,
      customerName: input.customer.name,
      phone: input.customer.phone,
      email: input.customer.email,
      districtId: district.id,
      districtName: district.name,
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
      address: input.address,
      deliveryZoneId: delivery.zone?.id ?? null,
      deliveryZoneName: delivery.zone?.name ?? null,
      locationId,
      weightGrams,
      subtotal,
      discount: input.discount,
      deliveryFee,
      total,
      advanceRequired,
      customerNote: input.customerNote,
      staffNote: input.staffNote,
    },
  };
}

/** The customer with this phone number, created if new. Name and email are filled in when missing. */
async function customerFor(tx: Tx, input: OrderInput) {
  const [found] = await tx.select().from(customers).where(eq(customers.phone, input.customer.phone));
  if (found) {
    if (!found.email && input.customer.email) await tx.update(customers).set({ email: input.customer.email }).where(eq(customers.id, found.id));
    return found.id;
  }
  const [created] = await tx
    .insert(customers)
    .values({
      name: input.customer.name,
      phone: input.customer.phone,
      email: input.customer.email,
      type: input.type === 'wholesale' ? 'business' : 'retail',
    })
    .returning({ id: customers.id });
  return created!.id;
}

const event = (tx: Tx, orderId: number, type: OrderEventType, message: string, adminUserId: number | null) =>
  tx.insert(orderEvents).values({ orderId, type, message, adminUserId });

const itemRows = (orderId: number, built: Awaited<ReturnType<typeof build>>) =>
  built.items.map((i) => ({
    orderId,
    productId: i.variant.productId,
    variantId: i.variant.variantId,
    name: i.variant.name,
    variantLabel: variantLabel(i.variant),
    sku: i.variant.sku,
    imageId: i.variant.imageId,
    regularPrice: i.regularPrice,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    lineTotal: i.lineTotal,
    weightGrams: i.weightGrams,
    stockTaken: i.variant.trackStock ? i.quantity : 0,
    position: i.position,
  }));

export async function createOrder(input: OrderInput, adminUserId: number) {
  return db.transaction(async (tx) => {
    const locationId = input.locationId ?? (await defaultLocationId(tx));
    const built = await build(tx, input, locationId);
    const customerId = await customerFor(tx, input);
    const [order] = await tx
      .insert(orders)
      .values({ ...built.values, customerId, createdBy: adminUserId })
      .returning({ id: orders.id, number: orders.number });
    const rows = itemRows(order!.id, built);
    await tx.insert(orderItems).values(rows);
    for (const row of rows) {
      if (row.stockTaken) await changeStock(tx, row.variantId, locationId, -row.stockTaken, 'order', adminUserId, `Order #${order!.number}`);
    }
    await event(tx, order!.id, 'created', `Order placed (${input.channel}), ${taka(built.values.total)}`, adminUserId);
    return order!;
  });
}

async function lockOrder(tx: Tx, id: number) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
  if (!order) throw notFound('Order not found');
  return order;
}

/** Changes an order that is not packed yet. Stock follows the new quantities. */
export async function updateOrder(id: number, input: OrderInput, adminUserId: number) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (!EDITABLE.includes(order.status)) throw badRequest('Only pending or confirmed orders can be changed');
    const locationId = input.locationId ?? order.locationId;

    const old = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
    const held = new Map<number, number>();
    if (locationId === order.locationId) {
      for (const i of old) if (i.variantId && i.stockTaken) held.set(i.variantId, (held.get(i.variantId) ?? 0) + i.stockTaken);
    }
    const built = await build(tx, input, locationId, held);

    // Give back what the old lines took, take what the new lines need.
    const note = `Order #${order.number} changed`;
    for (const i of old) {
      if (i.variantId && i.stockTaken) await changeStock(tx, i.variantId, order.locationId, i.stockTaken, 'order', adminUserId, note);
    }
    await tx.delete(orderItems).where(eq(orderItems.orderId, id));
    const rows = itemRows(id, built);
    await tx.insert(orderItems).values(rows);
    for (const row of rows) {
      if (row.stockTaken) await changeStock(tx, row.variantId, locationId, -row.stockTaken, 'order', adminUserId, note);
    }

    const customerId = await customerFor(tx, input);
    await tx
      .update(orders)
      .set({ ...built.values, customerId, paymentStatus: paymentStatusOf(order.paidAmount, built.values.total, await hadRefund(tx, id)) })
      .where(eq(orders.id, id));
    const changes = [
      order.total !== built.values.total && `total ${taka(order.total)} → ${taka(built.values.total)}`,
      order.address !== input.address && 'address',
      order.phone !== input.customer.phone && 'phone',
    ].filter(Boolean);
    await event(tx, id, 'edited', `Order changed${changes.length ? `: ${changes.join(', ')}` : ''}`, adminUserId);
  });
}

function paymentStatusOf(paid: number, total: number, refunded: boolean): PaymentStatus {
  if (paid >= total && total > 0) return 'paid';
  if (paid > 0) return 'partial';
  return refunded ? 'refunded' : 'unpaid';
}

async function hadRefund(tx: Tx, orderId: number) {
  const [row] = await tx
    .select({ id: orderPayments.id })
    .from(orderPayments)
    .where(and(eq(orderPayments.orderId, orderId), sql`${orderPayments.amount} < 0`))
    .limit(1);
  return !!row;
}

const STATUS_WORDS: Record<OrderStatus, string> = {
  pending: 'Back to pending',
  confirmed: 'Confirmed',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

async function recordPayment(
  tx: Tx,
  order: typeof orders.$inferSelect,
  payment: { method: (typeof orders.$inferSelect)['paymentMethod']; amount: number; reference: string | null; note: string | null },
  adminUserId: number,
) {
  await tx.insert(orderPayments).values({ orderId: order.id, ...payment, createdBy: adminUserId });
  const paid = round(order.paidAmount + payment.amount);
  const refunded = payment.amount < 0 || (await hadRefund(tx, order.id));
  await tx.update(orders).set({ paidAmount: paid, paymentStatus: paymentStatusOf(paid, order.total, refunded) }).where(eq(orders.id, order.id));
  const what = payment.amount < 0 ? `Paid back ${taka(-payment.amount)}` : `Payment ${taka(payment.amount)}`;
  await event(tx, order.id, 'payment', `${what} (${payment.method}${payment.reference ? `, ${payment.reference}` : ''})`, adminUserId);
}

export async function addPayment(id: number, payment: Parameters<typeof recordPayment>[2], adminUserId: number) {
  return db.transaction(async (tx) => recordPayment(tx, await lockOrder(tx, id), payment, adminUserId));
}

export async function setStatus(
  id: number,
  input: { status: OrderStatus; note: string | null; courier?: string | null; trackingCode?: string | null; collectDue: boolean },
  adminUserId: number,
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (!STATUS_FLOW[order.status].includes(input.status)) {
      throw badRequest(`A ${order.status} order cannot be marked ${input.status}`);
    }

    // Cancelled or returned: the stock goes back.
    if (HOLDS_STOCK(order.status) && !HOLDS_STOCK(input.status)) {
      const reason = input.status === 'returned' ? 'return' : 'order_cancel';
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      for (const i of items) {
        if (i.variantId && i.stockTaken) {
          await changeStock(tx, i.variantId, order.locationId, i.stockTaken, reason, adminUserId, `Order #${order.number} ${input.status}`);
        }
      }
      await tx.update(orderItems).set({ stockTaken: 0 }).where(eq(orderItems.orderId, id));
    }

    const now = new Date();
    await tx
      .update(orders)
      .set({
        status: input.status,
        ...(input.status === 'confirmed' && !order.confirmedAt && { confirmedAt: now }),
        ...(input.status === 'shipped' && { shippedAt: now }),
        ...(input.status === 'delivered' && { deliveredAt: now }),
        ...(input.status === 'cancelled' && { cancelledAt: now }),
        ...(input.courier !== undefined && { courier: input.courier }),
        ...(input.trackingCode !== undefined && { trackingCode: input.trackingCode }),
      })
      .where(eq(orders.id, id));

    const courier = input.status === 'shipped' && input.courier ? ` with ${input.courier}${input.trackingCode ? ` (${input.trackingCode})` : ''}` : '';
    await event(tx, id, 'status', `${STATUS_WORDS[input.status]}${courier}${input.note ? `: ${input.note}` : ''}`, adminUserId);

    const due = round(order.total - order.paidAmount);
    if (input.status === 'delivered' && input.collectDue && due > 0) {
      await recordPayment(tx, { ...order }, { method: 'cod', amount: due, reference: null, note: 'Collected on delivery' }, adminUserId);
    }
  });
}

export async function addNote(id: number, note: string, adminUserId: number) {
  return db.transaction(async (tx) => {
    await lockOrder(tx, id);
    await event(tx, id, 'note', note, adminUserId);
  });
}

export async function setCourier(id: number, courier: string | null, trackingCode: string | null, adminUserId: number) {
  return db.transaction(async (tx) => {
    await lockOrder(tx, id);
    await tx.update(orders).set({ courier, trackingCode }).where(eq(orders.id, id));
    await event(tx, id, 'courier', courier ? `Courier: ${courier}${trackingCode ? `, tracking ${trackingCode}` : ''}` : 'Courier removed', adminUserId);
  });
}
