import { randomBytes } from 'node:crypto';
import { asc, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { customers, customRequests, orders, products, productVariants, quotationItems, quotations, type OrderType } from '../../db/schema/index.ts';
import { badRequest } from '../../lib/errors.ts';
import { wholesaleTermsFor } from '../admin/customers/service.ts';
import { advanceFor, defaultLocationId, loadVariants, mergeLines, priceLines, variantLabel } from '../admin/orders/service.ts';
import type { Tx } from '../admin/products/service.ts';
import { DISTRICTS, getSettings, listZones, quote } from '../admin/settings/service.ts';
import { imagesById } from '../store/catalog.ts';

/**
 * Quotations: products at fixed prices, valid for a few days. Prices are worked out exactly as an
 * order's (today's price or the wholesale price, then bulk discounts), and kept: ordering the
 * quotation later uses these prices, whatever the shop's prices are by then.
 */

/** How long a quotation made from the cart is valid. */
export const QUOTE_DAYS = 7;
export const quoteNumber = (n: number) => `Q-${n}`;
const cents = (n: number) => Math.round(n * 100) / 100;
type Exec = Tx | typeof db;

/** A line as asked for: staff may type a special price per piece (then no bulk discount unless `bulk`). */
export interface QuoteLineIn {
  variantId: number;
  quantity: number;
  unitPrice?: number;
  bulk?: boolean;
}

/** A custom item on a staff quotation: made for this customer, priced by staff (no stock, no bulk discount). */
export interface CustomLineIn {
  custom: { name: string; details: string | null };
  quantity: number;
  unitPrice: number;
}

/**
 * Custom items become products made for one customer (never on the website, left out of the product
 * list), so the quotation, the order, stock, invoices and changes to the order treat them like any product.
 */
async function customProducts(tx: Tx, lines: (QuoteLineIn | CustomLineIn)[], adminUserId: number | null): Promise<QuoteLineIn[]> {
  const out: QuoteLineIn[] = [];
  for (const line of lines) {
    if (!('custom' in line)) {
      out.push(line);
      continue;
    }
    const [p] = await tx
      .insert(products)
      .values({
        name: line.custom.name,
        slug: `custom-${randomBytes(6).toString('hex')}`,
        status: 'draft',
        isCustom: true,
        description: line.custom.details ? `<p>${line.custom.details.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!).replace(/\n/g, '<br>')}</p>` : null,
        shortDescription: line.custom.details?.slice(0, 1000) ?? null,
        createdBy: adminUserId,
      })
      .returning({ id: products.id });
    const [v] = await tx.insert(productVariants).values({ productId: p!.id, price: line.unitPrice, trackStock: false }).returning({ id: productVariants.id });
    out.push({ variantId: v!.id, quantity: line.quantity, unitPrice: line.unitPrice, bulk: false });
  }
  return out;
}

/** Priced lines for a new quotation, exactly as an order prices them. Every product must still be for sale. */
export async function priceQuoteLines(exec: Exec, items: QuoteLineIn[], type: OrderType) {
  const lines = mergeLines(items);
  const variants = new Map((await loadVariants(exec, lines.map((l) => l.variantId), await defaultLocationId(exec))).map((v) => [v.variantId, v]));
  for (const line of lines) {
    const v = variants.get(line.variantId);
    // Custom products (made for one customer) are never on the website, but can be quoted.
    if (!v || (v.status !== 'active' && !v.isCustom)) {
      throw badRequest(v ? `${v.name} is no longer for sale. Remove it and try again.` : 'A product is no longer for sale. Remove it and try again.', {
        [`items.${line.index}.variantId`]: 'No longer for sale',
      });
    }
  }
  const { bulk } = await getSettings('checkout');
  const priced = priceLines(type, lines, variants, bulk);
  return {
    lines: priced.map((i, position) => ({
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
      position,
    })),
    subtotal: cents(priced.reduce((s, i) => s + i.lineTotal, 0)),
    bulkDiscount: cents(priced.reduce((s, i) => s + i.bulkDiscount, 0)),
  };
}

export interface NewQuotation {
  items: (QuoteLineIn | CustomLineIn)[];
  name: string;
  organisation: string | null;
  phone: string;
  email: string | null;
  note: string | null;
  /** Staff only. */
  terms?: string | null;
  /** Staff only: fixed delivery (0 = free); null = worked out when ordering. */
  deliveryFee?: number | null;
  /** Staff only: how many days it is valid (website quotations: QUOTE_DAYS). */
  validDays?: number;
}

/**
 * Makes a quotation. Answers its number and secret link token. `replaces`: a revision by staff, made in
 * the same transaction as the old quotation becomes "replaced" (so the old prices can no longer be ordered).
 */
export async function createQuotation(
  input: NewQuotation,
  ctx: { type: OrderType; customerId: number | null; source: 'website' | 'staff'; adminUserId: number | null; replaces?: number; customRequestId?: number | null },
) {
  return db.transaction(async (tx) => {
    if (ctx.replaces !== undefined) {
      const [old] = await tx.select({ status: quotations.status }).from(quotations).where(eq(quotations.id, ctx.replaces)).for('update');
      if (!old) throw badRequest('The quotation to revise was not found');
      if (old.status !== 'open') throw badRequest(`Only an open or expired quotation can be revised (this one is ${old.status}).`);
      await tx.update(quotations).set({ status: 'replaced', updatedAt: new Date() }).where(eq(quotations.id, ctx.replaces));
    }
    const priced = await priceQuoteLines(tx, await customProducts(tx, input.items, ctx.adminUserId), ctx.type);
    // Answering a custom request: it is now quoted.
    if (ctx.customRequestId) {
      const [r] = await tx.update(customRequests).set({ status: 'quoted', updatedAt: new Date() }).where(eq(customRequests.id, ctx.customRequestId)).returning({ id: customRequests.id });
      if (!r) throw badRequest('The custom request was not found');
    }
    const [q] = await tx
      .insert(quotations)
      .values({
        // Lower case only: the website lowercases page addresses (old links), and this one is in the path.
        publicToken: randomBytes(18).toString('hex'),
        source: ctx.source,
        type: ctx.type,
        customerId: ctx.customerId,
        name: input.name,
        organisation: input.organisation,
        phone: input.phone,
        email: input.email,
        note: input.note,
        subtotal: priced.subtotal,
        bulkDiscount: priced.bulkDiscount,
        validUntil: new Date(Date.now() + (input.validDays ?? QUOTE_DAYS) * 86_400_000),
        deliveryFee: input.deliveryFee ?? null,
        terms: input.terms ?? null,
        replacesId: ctx.replaces ?? null,
        customRequestId: ctx.customRequestId ?? null,
        createdBy: ctx.adminUserId,
      })
      .returning({ id: quotations.id, number: quotations.number, publicToken: quotations.publicToken });
    await tx.insert(quotationItems).values(priced.lines.map((l) => ({ ...l, quotationId: q!.id })));
    return q!;
  });
}

/** open, but past its date: shown as expired (it can no longer be ordered). */
export const shownStatus = (q: { status: string; validUntil: Date }, now = new Date()) => (q.status === 'open' && q.validUntil < now ? 'expired' : q.status);

/** A quotation with its lines (pictures included) and, once ordered, the order. */
export async function quotationWithItems(where: SQL) {
  const [q] = await db.select().from(quotations).where(where);
  if (!q) return null;
  const version = { id: quotations.id, number: quotations.number, publicToken: quotations.publicToken };
  const [items, [order], [newer], [older]] = await Promise.all([
    db.select().from(quotationItems).where(eq(quotationItems.quotationId, q.id)).orderBy(asc(quotationItems.position), asc(quotationItems.id)),
    q.orderId ? db.select({ number: orders.number, publicToken: orders.publicToken, id: orders.id }).from(orders).where(eq(orders.id, q.orderId)) : Promise.resolve([]),
    // A revision of this one (when replaced), and the one this replaces.
    q.status === 'replaced' ? db.select(version).from(quotations).where(eq(quotations.replacesId, q.id)).orderBy(desc(quotations.id)).limit(1) : Promise.resolve([]),
    q.replacesId ? db.select(version).from(quotations).where(eq(quotations.id, q.replacesId)) : Promise.resolve([]),
  ]);
  const images = await imagesById(items.map((i) => i.imageId));
  return {
    quotation: q,
    status: shownStatus(q),
    items: items.map(({ imageId, quotationId: _q, ...i }) => ({ ...i, image: imageId ? (images.get(imageId) ?? null) : null })),
    order: order ?? null,
    replacedBy: newer ?? null,
    replaces: older ?? null,
  };
}

/**
 * The delivery charge and total for ordering a quotation to a place: worked out as the order will be
 * (the zone, the quotation's subtotal and weight, wholesale terms). The order itself checks again.
 */
export async function quotationTotal(q: typeof quotations.$inferSelect, place: { districtId: string; areaId: string | null }) {
  if (!DISTRICTS.has(place.districtId)) throw badRequest('Choose your district', { districtId: 'Choose your district' });
  const items = await db.select({ variantId: quotationItems.variantId, quantity: quotationItems.quantity }).from(quotationItems).where(eq(quotationItems.quotationId, q.id));
  const ids = items.map((i) => i.variantId).filter((v): v is number => v !== null);
  const variants = ids.length ? await loadVariants(db, ids, await defaultLocationId()) : [];
  const weight = new Map(variants.map((v) => [v.variantId, v.weightGrams ?? 0]));
  const weightGrams = items.reduce((s, i) => s + (i.variantId ? (weight.get(i.variantId) ?? 0) : 0) * i.quantity, 0);
  const [shop, zones, [customer]] = await Promise.all([
    getSettings('checkout'),
    listZones(),
    q.customerId ? db.select().from(customers).where(eq(customers.id, q.customerId)) : Promise.resolve([]),
  ]);
  const checkout = { ...shop, wholesale: wholesaleTermsFor(customer, shop.wholesale) };
  const wholesale = q.type === 'wholesale';
  const delivery = quote(zones, checkout, { districtId: place.districtId, areaId: place.areaId, subtotal: q.subtotal, weightKg: weightGrams / 1000, wholesale });
  // Delivery fixed on the quotation by staff (0 = free) wins over the zone's charge.
  const fee = q.deliveryFee ?? delivery.fee;
  const total = fee === null ? null : cents(q.subtotal + fee);
  return {
    deliveryFee: fee,
    total,
    advance: wholesale && total !== null ? advanceFor(total, checkout.wholesale.advancePercent) : 0,
    // Staff quotations may be below the minimum (staff agreed it).
    minOrderAmount: wholesale && q.source === 'website' ? checkout.wholesale.minOrderAmount : null,
  };
}

