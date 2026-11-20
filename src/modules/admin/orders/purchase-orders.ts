import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import {
  adminUsers,
  brands,
  orderEvents,
  orderItems,
  orders,
  products,
  purchaseOrders,
  type BrandShipsTo,
  type OrderStatus,
  type PurchaseOrderLine,
} from '../../../db/schema/index.ts';
import { badRequest, conflict, notFound } from '../../../lib/errors.ts';
import { esc, layout, load, placeOf, type Loaded } from '../../store/order-emails.ts';
import { sendEmail } from '../integrations/service.ts';

/**
 * Purchase orders to brands, for products the shop does not stock ("Supplied by the brand"):
 * - when a customer order is confirmed, one draft per brand is made (delivery: the brand's usual choice);
 * - staff look over the email and send it (never sent by itself); they can send it again after a change;
 * - no prices: the shop settles those with the brand;
 * - if the customer order is cancelled after sending, staff can tell the brand with one click.
 */

/** Customer orders that need their brand items ordered. */
const ACTIVE: OrderStatus[] = ['confirmed', 'packed', 'shipped', 'delivered'];
/** Customer orders that are off: the brand should be told if a purchase order went out. */
const OFF: OrderStatus[] = ['cancelled', 'returned'];

type Exec = Pick<typeof db, 'select' | 'insert' | 'delete' | 'update'>;

export const poNumber = (n: number) => `PO-${n}`;

/** A customer order left the active steps (cancelled, returned, back to pending): unsent drafts go. */
export async function dropDrafts(exec: Exec, orderId: number) {
  await exec.delete(purchaseOrders).where(and(eq(purchaseOrders.orderId, orderId), eq(purchaseOrders.status, 'draft')));
}

/** The order's brand-supplied lines, live (for a draft, or to see what changed since sending). */
async function liveLines(exec: Exec, orderId: number) {
  const rows = await exec
    .select({
      brandId: products.brandId,
      name: orderItems.name,
      variantLabel: orderItems.variantLabel,
      sku: orderItems.sku,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(and(eq(orderItems.orderId, orderId), eq(products.suppliedByBrand, true)))
    .orderBy(asc(orderItems.position), asc(orderItems.id));
  const byBrand = new Map<number | null, PurchaseOrderLine[]>();
  for (const { brandId, ...line } of rows) byBrand.set(brandId, [...(byBrand.get(brandId) ?? []), line]);
  return byBrand;
}

/**
 * Makes the drafts an order needs: one per brand with supplied products, while the order is active.
 * Drafts for brands no longer in the order are removed (sent ones stay, so the brand can be told).
 * Safe to call any time (on confirm, after an edit, when the order page opens).
 */
export async function syncPurchaseOrders(exec: Exec, orderId: number) {
  const [order] = await exec.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order || !ACTIVE.includes(order.status)) return;
  const lines = await liveLines(exec, orderId);
  const brandIds = [...lines.keys()].filter((id): id is number => id !== null);
  if (brandIds.length) {
    const list = await exec.select({ id: brands.id, name: brands.name, shipsTo: brands.shipsTo }).from(brands).where(inArray(brands.id, brandIds));
    await exec
      .insert(purchaseOrders)
      .values(list.map((b) => ({ orderId, brandId: b.id, brandName: b.name, shipTo: b.shipsTo })))
      .onConflictDoNothing({ target: [purchaseOrders.orderId, purchaseOrders.brandId] });
  }
  await exec
    .delete(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.orderId, orderId),
        eq(purchaseOrders.status, 'draft'),
        brandIds.length ? sql`(${purchaseOrders.brandId} is null or ${notInArray(purchaseOrders.brandId, brandIds)})` : undefined,
      ),
    );
}

const sameLines = (a: PurchaseOrderLine[], b: PurchaseOrderLine[]) =>
  a.length === b.length && a.every((l, i) => l.name === b[i]!.name && l.variantLabel === b[i]!.variantLabel && l.sku === b[i]!.sku && l.quantity === b[i]!.quantity);

/** The order page's purchase orders, and supplied products that have no brand (nobody to order from). */
export async function purchaseOrdersOf(orderId: number, orderStatus: OrderStatus) {
  if (ACTIVE.includes(orderStatus)) await syncPurchaseOrders(db, orderId);
  const [rows, live] = await Promise.all([
    db
      .select({
        po: purchaseOrders,
        brandEmail: brands.orderEmail,
        brandSlug: brands.slug,
        sentByName: adminUsers.name,
      })
      .from(purchaseOrders)
      .leftJoin(brands, eq(brands.id, purchaseOrders.brandId))
      .leftJoin(adminUsers, eq(adminUsers.id, purchaseOrders.sentBy))
      .where(eq(purchaseOrders.orderId, orderId))
      .orderBy(asc(purchaseOrders.id)),
    liveLines(db, orderId),
  ]);
  const items = rows.map(({ po, brandEmail, brandSlug, sentByName }) => {
    const now = (po.brandId !== null && live.get(po.brandId)) || [];
    const sent = po.status === 'draft' ? null : (po.lines ?? []);
    return {
      id: po.id,
      number: poNumber(po.number),
      brandId: po.brandId,
      brandName: po.brandName,
      brandSlug,
      /** Where it goes (the brand's order email; null: not set yet). */
      email: brandEmail,
      status: po.status,
      shipTo: po.shipTo,
      note: po.note,
      /** Draft: what will be sent. Sent: what was sent. */
      lines: sent ?? now,
      sentTo: po.sentTo,
      sentAt: po.sentAt,
      sentByName,
      timesSent: po.timesSent,
      cancelSentAt: po.cancelSentAt,
      /** Sent, but the order's items for this brand changed since (send it again). */
      changedSinceSent: po.status === 'sent' && ACTIVE.includes(orderStatus) && !sameLines(sent!, now),
      /** Sent, and the brand should now be told it is off (order cancelled, or its items removed). */
      needsCancel: po.status === 'sent' && !po.cancelSentAt && (OFF.includes(orderStatus) || now.length === 0),
    };
  });
  return { items, withoutBrand: live.get(null) ?? [] };
}

// ---- The emails ----

type Kind = 'order' | 'cancel';

function linesTable(lines: PurchaseOrderLine[]) {
  const th = 'padding:8px;text-align:left;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e4e4e7';
  const td = 'padding:10px 8px;font-size:14px;border-bottom:1px solid #f4f4f5;vertical-align:top';
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="${td}">${esc(l.name)}${l.variantLabel ? `<br><span style="color:#71717a;font-size:13px">${esc(l.variantLabel)}</span>` : ''}</td><td style="${td};color:#52525b">${esc(l.sku ?? '—')}</td><td style="${td};text-align:right;font-weight:700;white-space:nowrap">${l.quantity}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse"><tr><th style="${th}">Product</th><th style="${th}">SKU</th><th style="${th};text-align:right">Quantity</th></tr>${rows}</table>`;
}

function deliverTo(d: Loaded, shipTo: BrandShipsTo) {
  const { store, order } = d;
  if (shipTo === 'customer') {
    return {
      html: `<p style="margin:16px 0 4px;font-weight:700">Please deliver straight to our customer:</p><p style="margin:0;line-height:1.6">${esc(order.customerName)}<br>${esc(order.phone)}<br>${esc(placeOf(order))}</p>`,
      text: `Please deliver straight to our customer:\n${order.customerName}\n${order.phone}\n${placeOf(order)}`,
    };
  }
  const where = [store.address, store.phone && `Phone: ${store.phone}`].filter(Boolean) as string[];
  return {
    html: `<p style="margin:16px 0 4px;font-weight:700">Please deliver to our shop:</p><p style="margin:0;line-height:1.6">${esc(store.name)}${where.map((w) => `<br>${esc(w)}`).join('')}</p>`,
    text: `Please deliver to our shop:\n${[store.name, ...where].join('\n')}`,
  };
}

/** The email for a purchase order (or its cancellation): subject, HTML and plain text. */
export function purchaseOrderEmail(d: Loaded, po: { number: number; brandName: string; shipTo: BrandShipsTo; note: string | null }, lines: PurchaseOrderLine[], kind: Kind) {
  const { store, order } = d;
  const no = poNumber(po.number);
  const contact = [store.phone, store.email].filter(Boolean).join(' · ');
  if (kind === 'cancel') {
    const subject = `Cancelled: purchase order ${no} from ${store.name}`;
    const html = layout(
      d,
      `Please cancel purchase order ${no}`,
      `<p style="margin:0 0 8px;line-height:1.6">Dear ${esc(po.brandName)} team,</p>
<p style="margin:0 0 8px;line-height:1.6">Our customer's order #${order.number} was cancelled, so we no longer need the items of purchase order <strong>${no}</strong>. Please do not send them.</p>
${linesTable(lines)}
<p style="margin:0;line-height:1.6">If they are already on the way, please reply to this email so we can sort it out.${contact ? ` You can also call us: ${esc(contact)}.` : ''}</p>`,
    );
    const text = [
      `Dear ${po.brandName} team,`,
      '',
      `Our customer's order #${order.number} was cancelled, so we no longer need the items of purchase order ${no}. Please do not send them.`,
      '',
      ...lines.map((l) => `- ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ''}${l.sku ? ` [${l.sku}]` : ''} × ${l.quantity}`),
      '',
      `If they are already on the way, please reply to this email.${contact ? ` Call us: ${contact}` : ''}`,
      '',
      store.name,
    ].join('\n');
    return { subject, html, text };
  }
  const to = deliverTo(d, po.shipTo);
  const subject = `Purchase order ${no} from ${store.name} (order #${order.number})`;
  const html = layout(
    d,
    `Purchase order ${no}`,
    `<p style="margin:0 0 8px;line-height:1.6">Dear ${esc(po.brandName)} team,</p>
<p style="margin:0 0 8px;line-height:1.6">Please supply the items below for our order #${order.number}.</p>
${linesTable(lines)}
${to.html}
${po.note ? `<p style="margin:16px 0 0;padding:12px 14px;background:#fefce8;border-radius:10px;line-height:1.6"><strong>Note:</strong> ${esc(po.note).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin:16px 0 0;line-height:1.6">Please reply to this email to confirm, and tell us when it will be sent.${contact ? ` Questions: ${esc(contact)}.` : ''}</p>`,
  );
  const text = [
    `Purchase order ${no}`,
    '',
    `Dear ${po.brandName} team,`,
    '',
    `Please supply the items below for our order #${order.number}.`,
    '',
    ...lines.map((l) => `- ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ''}${l.sku ? ` [${l.sku}]` : ''} × ${l.quantity}`),
    '',
    to.text,
    ...(po.note ? ['', `Note: ${po.note}`] : []),
    '',
    `Please reply to this email to confirm, and tell us when it will be sent.${contact ? ` Questions: ${contact}` : ''}`,
    '',
    store.name,
  ].join('\n');
  return { subject, html, text };
}

// ---- Staff actions ----

async function loadOne(orderId: number, poId: number) {
  const [row] = await db
    .select({ po: purchaseOrders, email: brands.orderEmail })
    .from(purchaseOrders)
    .leftJoin(brands, eq(brands.id, purchaseOrders.brandId))
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.orderId, orderId)));
  if (!row) throw notFound('Purchase order not found');
  return row;
}

/** Before sending: what the brand will get, and anything staff should know first. */
export async function previewPurchaseOrder(orderId: number, poId: number, kind: Kind) {
  const { po, email } = await loadOne(orderId, poId);
  const d = await load(orderId);
  if (!d) throw notFound('Order not found');
  const lines = kind === 'cancel' ? (po.lines ?? []) : ((po.brandId !== null && (await liveLines(db, orderId)).get(po.brandId)) || []);
  const warnings: string[] = [];
  if (!email) warnings.push(`${po.brandName} has no order email yet. Add it on the brand's page (Catalog → Brands).`);
  if (kind === 'order' && !lines.length) warnings.push(`This order has no ${po.brandName} products supplied by the brand any more.`);
  const due = Math.round((d.order.total - d.order.paidAmount) * 100) / 100;
  if (kind === 'order' && po.shipTo === 'customer' && due > 0) {
    warnings.push(`The customer still has ৳${due.toLocaleString('en-US')} to pay. As the brand delivers to the customer, agree with the brand who collects it (you can add a note).`);
  }
  return { to: email, ...purchaseOrderEmail(d, po, lines, kind), warnings };
}

export async function updatePurchaseOrder(orderId: number, poId: number, input: { shipTo?: BrandShipsTo; note?: string | null }) {
  const { po } = await loadOne(orderId, poId);
  if (po.status === 'cancelled') throw badRequest('This purchase order was cancelled');
  await db
    .update(purchaseOrders)
    .set({ ...(input.shipTo && { shipTo: input.shipTo }), ...(input.note !== undefined && { note: input.note }), updatedAt: new Date() })
    .where(eq(purchaseOrders.id, poId));
}

/**
 * Emails the purchase order (or its cancellation) to the brand. One at a time per purchase order: a
 * second click while it is being sent is turned away. Test mode (email settings): only written to the
 * message log, and said so.
 */
export async function sendPurchaseOrder(orderId: number, poId: number, kind: Kind, adminUserId: number) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from purchase_orders where id = ${poId} and order_id = ${orderId} for update nowait`).catch((err: { cause?: { code?: string }; code?: string }) => {
      if ((err.cause?.code ?? err.code) === '55P03') throw conflict('This purchase order is being sent right now');
      throw err;
    });
    if (!locked.rows.length) throw notFound('Purchase order not found');
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    const [row] = await tx
      .select({ po: purchaseOrders, email: brands.orderEmail })
      .from(purchaseOrders)
      .leftJoin(brands, eq(brands.id, purchaseOrders.brandId))
      .where(eq(purchaseOrders.id, poId));
    const { po, email } = row!;
    if (!email) throw badRequest(`${po.brandName} has no order email yet. Add it on the brand's page first.`);

    let lines: PurchaseOrderLine[];
    if (kind === 'order') {
      if (!ACTIVE.includes(order!.status)) throw badRequest('Purchase orders are sent for confirmed orders only');
      if (po.status === 'cancelled') throw badRequest('This purchase order was cancelled');
      lines = (po.brandId !== null && (await liveLines(tx, orderId)).get(po.brandId)) || [];
      if (!lines.length) throw badRequest(`This order has no ${po.brandName} products supplied by the brand any more`);
    } else {
      if (po.status !== 'sent') throw badRequest('Only a sent purchase order can be cancelled with the brand');
      lines = po.lines ?? [];
    }

    const d = await load(orderId);
    const mail = purchaseOrderEmail(d!, po, lines, kind);
    const message = await sendEmail({ to: email, ...mail, purpose: `${kind === 'order' ? 'po.sent' : 'po.cancel'} ${poNumber(po.number)}` });
    if (message.status === 'failed') throw badRequest(`The email did not go out: ${message.error ?? 'unknown error'}`);
    const testOnly = message.status === 'logged';

    const now = new Date();
    if (kind === 'order') {
      await tx
        .update(purchaseOrders)
        .set({ status: 'sent', sentTo: email, lines, sentAt: now, sentBy: adminUserId, timesSent: sql`${purchaseOrders.timesSent} + 1`, updatedAt: now })
        .where(eq(purchaseOrders.id, poId));
    } else {
      await tx.update(purchaseOrders).set({ status: 'cancelled', cancelSentAt: now, updatedAt: now }).where(eq(purchaseOrders.id, poId));
    }
    const again = kind === 'order' && po.timesSent > 0 ? ' again' : '';
    const what = kind === 'order' ? `Purchase order ${poNumber(po.number)} sent${again} to ${po.brandName} (${email})` : `${po.brandName} told to cancel purchase order ${poNumber(po.number)} (${email})`;
    await tx.insert(orderEvents).values({ orderId, type: 'purchase', message: `${what}${testOnly ? ' — test mode: written to the message log only' : ''}`, adminUserId });
    return { testOnly, note: testOnly ? (message.error ?? 'Test mode: written to the message log only') : null };
  });
}

/** Orders with purchase orders to send (drafts), or to cancel with the brand: for the orders list. */
export const poWaiting = {
  toSend: sql<number>`(select count(*) from purchase_orders po where po.order_id = "orders"."id" and po.status = 'draft' and "orders"."status" in ('confirmed', 'packed', 'shipped', 'delivered'))`.mapWith(Number),
  toCancel: sql<number>`(select count(*) from purchase_orders po where po.order_id = "orders"."id" and po.status = 'sent' and po.cancel_sent_at is null and "orders"."status" in ('cancelled', 'returned'))`.mapWith(Number),
};
/** How many orders in the whole shop have purchase orders waiting (to send, or to cancel with the brand). */
export async function draftsWaiting() {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .where(sql`exists (select 1 from purchase_orders po where po.order_id = "orders"."id") and (${poWaiting.toSend} + ${poWaiting.toCancel}) > 0`);
  return row?.n ?? 0;
}
