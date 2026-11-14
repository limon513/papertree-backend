import { applyBulk, type BulkRules } from '../../../lib/bulk.ts';
import { checkCouponUse, cleanCode, CouponError, couponFor, findCoupon, shortfallMessage } from '../coupons/service.ts';
import type { OrderType } from '../../../db/schema/orders.ts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { coupons,
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
import { AppError, badRequest, notFound } from '../../../lib/errors.ts';
import { rememberAddress, wholesaleTermsFor } from '../customers/service.ts';
import { changeStock, type Tx } from '../products/service.ts';
import { AREAS, DISTRICTS, getSettings, listZones, quote } from '../settings/service.ts';
import { STATUS_FLOW, type OrderInput } from './schemas.ts';

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The advance of a wholesale order: `percent` of the total, rounded up to whole taka. Computer maths
 * can give 77.00000000000001 for 77, so it is first cut to 4 decimals (else that would become 78).
 */
export const advanceFor = (total: number, percent: number) => Math.ceil(Math.round(((total * percent) / 100) * 10_000) / 10_000);
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
      bulk: products.bulkDiscount,
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

export interface OrderLineIn {
  variantId: number;
  quantity: number;
  unitPrice?: number;
  bulk?: boolean;
}

/** The same product twice becomes one line (the first line's price is kept). `index`: where it was in the form. */
export function mergeLines(items: OrderLineIn[]) {
  const lines: (OrderLineIn & { index: number })[] = [];
  items.forEach((item, index) => {
    const same = lines.find((l) => l.variantId === item.variantId);
    if (same) same.quantity += item.quantity;
    else lines.push({ ...item, index });
  });
  return lines;
}

/**
 * The money of each line: the product's price today (or the price staff typed), then bulk discounts
 * (retail only; lines with a typed price only when `bulk` says so). Used to save an order and to show
 * its prices in the order form, so both always agree. Every line's variant must be in `variants`.
 */
export function priceLines(type: OrderType, lines: (OrderLineIn & { index: number })[], variants: Map<number, VariantRow>, bulkRules: BulkRules, now = new Date()) {
  const items = lines.map((line, position) => {
    const v = variants.get(line.variantId)!;
    const listPrice = type === 'wholesale' ? (v.wholesalePrice ?? retailPrice(v, now)) : retailPrice(v, now);
    const unitPrice = round(line.unitPrice ?? listPrice);
    return {
      variant: v,
      position,
      index: line.index,
      quantity: line.quantity,
      regularPrice: v.price,
      /** Before any bulk discount. */
      basePrice: unitPrice,
      unitPrice,
      lineTotal: round(unitPrice * line.quantity),
      weightGrams: v.weightGrams,
      bulkOk: line.bulk ?? line.unitPrice === undefined,
      bulkPercent: null as number | null,
      bulkDiscount: 0,
      bulkNext: null as { more: number; percent: number } | null,
    };
  });
  if (type !== 'retail') return items;
  // Only the lines that may have it count towards the steps.
  const eligible = items.filter((i) => i.bulkOk);
  const out = applyBulk(
    eligible.map((i) => ({ productId: i.variant.productId, quantity: i.quantity, price: i.basePrice, onSale: i.basePrice < i.variant.price })),
    bulkRules,
    new Map(eligible.map((i) => [i.variant.productId, i.variant.bulk])),
  );
  eligible.forEach((item, k) => {
    const b = out[k]!;
    item.bulkNext = b.next;
    if (!b.percent) return;
    item.unitPrice = b.unitPrice;
    item.lineTotal = b.lineTotal;
    item.bulkPercent = b.percent;
    item.bulkDiscount = b.discount;
  });
  return items;
}

/**
 * Works out the order from what staff entered: prices, stock, weight, delivery and totals.
 * `heldNow` is the stock this order already holds per variant (when editing), which counts as available.
 */
/** Who is ordering, for coupon rules. */
export interface OrderContext {
  /** A signed-in shopper (website). */
  customerId?: number | null;
  /** Website wholesale orders: the business's minimum order must be reached (staff may go below it). */
  enforceMinimum?: boolean;
  /** The order being edited: its coupon is kept (no new use counted) while the items still qualify. */
  existing?: { id: number; couponId: number | null; couponCode: string | null; customerId: number | null } | null;
}

/** The lines as the coupon maths needs them. */
export const couponInput = (items: ReturnType<typeof priceLines>, now = new Date()) =>
  items.map((i) => ({ productId: i.variant.productId, lineTotal: i.lineTotal, onSale: retailPrice(i.variant, now) < i.variant.price, bulkPercent: i.bulkPercent }));

/**
 * The order's coupon: checked (a new code: dates, limits, who; its row locked so use limits stay exact)
 * and worked out. Throws a CouponError when a new code cannot be used. An order's own coupon, when
 * edited, is only re-worked out, and comes off if the items no longer qualify.
 */
export async function orderCoupon(
  tx: Tx,
  args: { code: string | null; type: OrderType; phone: string | null; customerId: number | null; existing?: OrderContext['existing']; preview?: boolean },
  items: ReturnType<typeof priceLines>,
  deliveryFee: number | null,
) {
  const code = args.code ? cleanCode(args.code) : '';
  if (!code) return null;
  if (args.type === 'wholesale') throw new CouponError('wholesale', 'Coupons are for retail orders.');
  const kept = !!args.existing?.couponId && args.existing.couponCode === code;
  // A new use locks the coupon row until the order is saved (not for a preview).
  const c = await findCoupon(tx, code, !kept && !args.preview);
  if (kept && !c) return null;
  if (!kept) await checkCouponUse(tx, c, { phone: args.phone, customerId: args.customerId, orderId: args.existing?.id ?? null });
  const result = await couponFor(tx, c!, couponInput(items), deliveryFee);
  if (!result.ok) {
    if (kept) return null;
    throw new CouponError(result.reason ?? 'no_items', shortfallMessage(result));
  }
  // Free delivery when the delivery is free anyway: nothing to use it for.
  if (result.itemsOff + result.deliveryOff <= 0) return null;
  return { id: c!.id, code: c!.code, itemsOff: result.itemsOff, deliveryOff: result.deliveryOff, isNew: !kept };
}

async function build(tx: Tx, input: OrderInput, locationId: number, heldNow = new Map<number, number>(), ctx: OrderContext = {}) {
  const district = DISTRICTS.get(input.districtId);
  if (!district) throw badRequest('Choose a district', { districtId: 'Choose a district' });
  const area = input.areaId ? AREAS.get(input.areaId) : null;
  if (input.areaId && area?.districtId !== input.districtId) {
    throw badRequest('Choose an area in this district', { areaId: 'Choose an area in this district' });
  }

  const lines = mergeLines(input.items);
  const variants = new Map((await loadVariants(tx, lines.map((l) => l.variantId), locationId)).map((v) => [v.variantId, v]));
  for (const line of lines) {
    const v = variants.get(line.variantId);
    if (!v) throw badRequest('A product in the order no longer exists', { [`items.${line.index}.variantId`]: 'This product no longer exists' });
    if (v.trackStock && !v.allowBackorder) {
      const available = v.stock + (heldNow.get(v.variantId) ?? 0);
      if (line.quantity > available) {
        const message = available > 0 ? `Only ${available} in stock` : 'Out of stock';
        throw badRequest(`${v.name}: ${message.toLowerCase()}`, { [`items.${line.index}.quantity`]: message });
      }
    }
  }
  const shop = await getSettings('checkout');
  const items = priceLines(input.type, lines, variants, shop.bulk);

  const subtotal = round(items.reduce((sum, i) => sum + i.lineTotal, 0));
  if (input.discount > subtotal) throw badRequest('The discount is bigger than the order', { discount: 'More than the order amount' });
  const weightGrams = items.reduce((sum, i) => sum + (i.weightGrams ?? 0) * i.quantity, 0);

  const [zones, [customer]] = await Promise.all([
    listZones(),
    // A signed-in shopper's own account (its terms), whatever phone this delivery uses; else by phone.
    ctx.customerId
      ? tx.select().from(customers).where(eq(customers.id, ctx.customerId))
      : tx.select().from(customers).where(eq(customers.phone, input.customer.phone)),
  ]);
  // A business with its own terms (advance, delivery) gets them on its wholesale orders.
  const checkout = { ...shop, wholesale: wholesaleTermsFor(customer, shop.wholesale) };
  const minimum = checkout.wholesale.minOrderAmount;
  if (input.type === 'wholesale' && ctx.enforceMinimum && minimum !== null && subtotal < minimum) {
    throw new AppError(409, 'BELOW_MINIMUM', `Wholesale orders start at ${taka(minimum)}. Please add ${taka(round(minimum - subtotal))} more.`);
  }
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

  const coupon = await orderCoupon(
    tx,
    { code: input.couponCode, type: input.type, phone: input.customer.phone, customerId: ctx.customerId ?? ctx.existing?.customerId ?? customer?.id ?? null, existing: ctx.existing },
    items,
    deliveryFee,
  );
  const couponDiscount = coupon ? coupon.itemsOff + coupon.deliveryOff : 0;
  // Never below zero: the items part of discounts cannot be more than the items.
  if (input.discount + (coupon?.itemsOff ?? 0) > subtotal) {
    throw badRequest('The discount and the coupon together are more than the items', { discount: 'Too much with the coupon' });
  }
  const total = round(subtotal - input.discount - couponDiscount + deliveryFee);
  // Whole taka, rounded up.
  const advanceRequired = input.type === 'wholesale' ? advanceFor(total, checkout.wholesale.advancePercent) : 0;

  return {
    items,
    coupon,
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
      bulkDiscount: round(items.reduce((sum, i) => sum + i.bulkDiscount, 0)),
      deliveryFee,
      couponId: coupon?.id ?? null,
      couponCode: coupon?.code ?? null,
      couponDiscount,
      total,
      advanceRequired,
      customerNote: input.customerNote,
      staffNote: input.staffNote,
    },
  };
}

/**
 * The customer with this phone number, created if new (a wholesale order by staff makes an approved business).
 * Name and email are filled in when missing, and the address is saved for next time.
 */
async function customerFor(tx: Tx, input: OrderInput, knownId?: number) {
  if (knownId) {
    await rememberAddress(tx, knownId, { districtId: input.districtId, areaId: input.areaId, address: input.address });
    return { id: knownId, created: false };
  }
  const [found] = await tx.select().from(customers).where(eq(customers.phone, input.customer.phone));
  let id = found?.id;
  if (found) {
    if (!found.email && input.customer.email) await tx.update(customers).set({ email: input.customer.email }).where(eq(customers.id, found.id));
  } else {
    const wholesale = input.type === 'wholesale';
    const [created] = await tx
      .insert(customers)
      .values({
        name: input.customer.name,
        phone: input.customer.phone,
        email: input.customer.email,
        type: wholesale ? 'business' : 'retail',
        ...(wholesale && { businessName: input.customer.name, businessStatus: 'approved' as const }),
      })
      .returning({ id: customers.id });
    id = created!.id;
  }
  await rememberAddress(tx, id!, { districtId: input.districtId, areaId: input.areaId, address: input.address });
  return { id: id!, created: !found };
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
    bulkPercent: i.bulkPercent,
    bulkDiscount: i.bulkDiscount,
    weightGrams: i.weightGrams,
    stockTaken: i.variant.trackStock ? i.quantity : 0,
    position: i.position,
  }));

export interface CreateOrderExtras {
  /** The total the shopper saw. If prices changed since, the order is not placed (409 PRICE_CHANGED). */
  expectedTotal?: number;
  /** Website orders: the secret for the "thank you" link. */
  publicToken?: string;
  /** Website orders: the browser's id for this attempt (one order per id). */
  requestId?: string;
  /** Website orders from a signed-in shopper: the order is theirs, whatever phone is given. */
  customerId?: number;
  /** Website wholesale orders: refuse an order below the business's minimum. */
  enforceMinimum?: boolean;
}

/** Places an order. `adminUserId` is null for orders from the website. */
export async function createOrder(input: OrderInput, adminUserId: number | null, extras: CreateOrderExtras = {}) {
  return db.transaction(async (tx) => {
    const locationId = input.locationId ?? (await defaultLocationId(tx));
    const built = await build(tx, input, locationId, undefined, { customerId: extras.customerId ?? null, enforceMinimum: extras.enforceMinimum });
    if (extras.expectedTotal !== undefined && Math.abs(extras.expectedTotal - built.values.total) > 0.009) {
      throw new AppError(409, 'PRICE_CHANGED', `Prices changed: the total is now ${taka(built.values.total)}. Please check your order and place it again.`);
    }
    const customer = await customerFor(tx, input, extras.customerId);
    const customerId = customer.id;
    const [order] = await tx
      .insert(orders)
      .values({ ...built.values, customerId, createdBy: adminUserId, publicToken: extras.publicToken ?? null, requestId: extras.requestId ?? null })
      .returning({ id: orders.id, number: orders.number, total: orders.total, publicToken: orders.publicToken });
    const rows = itemRows(order!.id, built);
    await tx.insert(orderItems).values(rows);
    for (const [i, row] of rows.entries()) {
      if (!row.stockTaken) continue;
      const left = await changeStock(tx, row.variantId!, locationId, -row.stockTaken, 'order', adminUserId, `Order #${order!.number}`);
      // Someone else took the last ones a moment ago (the stock row is locked, so this is exact).
      const v = built.items[i]!.variant;
      if (left < 0 && !v.allowBackorder) {
        const available = left + row.stockTaken;
        const message = available > 0 ? `Only ${available} in stock` : 'Out of stock';
        throw badRequest(`${v.name}: ${message.toLowerCase()}`, { [`items.${i}.quantity`]: message });
      }
    }
    if (built.coupon?.isNew) await useCoupon(tx, built.coupon.id);
    await event(tx, order!.id, 'created', `Order placed (${input.channel}), ${taka(built.values.total)}${built.coupon ? `, coupon ${built.coupon.code}` : ''}`, adminUserId);
    return { ...order!, customerId, newCustomer: customer.created };
  });
}

/** One more use of a coupon. Its row is already locked by this order's transaction, so the count stays exact. */
async function useCoupon(tx: Tx, couponId: number) {
  await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} + 1` }).where(eq(coupons.id, couponId));
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
    const built = await build(tx, input, locationId, held, {
      existing: { id: order.id, couponId: order.couponId, couponCode: order.couponCode, customerId: order.customerId },
      // Same phone: it stays that customer's order, with its terms (a business order sent to its manager's phone).
      customerId: order.phone === input.customer.phone ? order.customerId : null,
    });

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

    // Same phone: the order stays with its customer (a signed-in shopper's gift order stays in their account).
    const customerId = (await customerFor(tx, input, order.phone === input.customer.phone ? (order.customerId ?? undefined) : undefined)).id;
    if (built.coupon?.isNew) await useCoupon(tx, built.coupon.id);
    await tx
      .update(orders)
      .set({ ...built.values, customerId, paymentStatus: paymentStatusOf(order.paidAmount, built.values.total, await hadRefund(tx, id)) })
      .where(eq(orders.id, id));
    const changes = [
      order.total !== built.values.total && `total ${taka(order.total)} → ${taka(built.values.total)}`,
      order.address !== input.address && 'address',
      order.phone !== input.customer.phone && 'phone',
      order.couponCode !== (built.coupon?.code ?? null) && (built.coupon ? `coupon ${built.coupon.code}` : `coupon ${order.couponCode} removed`),
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
  adminUserId: number | null,
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
  /** null: done by the shop's systems (Steadfast), not a person. */
  adminUserId: number | null,
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
