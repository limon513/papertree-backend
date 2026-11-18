import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { onlinePayments, orderItems, orders, type OnlinePaymentStatus } from '../../db/schema/index.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { badRequest, conflict } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { recordSystemPayment, systemNote } from '../admin/orders/service.ts';
import { gateway, lookUp, startSession, validate, type Validation } from './sslcommerz.ts';

/**
 * Paying an order online with SSLCommerz. Money rules:
 * - The amount is worked out here from the order (never from the browser).
 * - A payment counts only when SSLCommerz's validation API confirms it, for this try's transaction id,
 *   in taka, for exactly the amount asked. The shopper's return and the IPN are only hints to check.
 * - Each try becomes at most one payment (the try is locked and marked paid in the same transaction).
 */
type Order = typeof orders.$inferSelect;

const paisa = (n: number) => Math.round(n * 100);
const taka = (p: number) => Math.round(p) / 100;
/** SSLCommerz does not take less than ৳10. */
export const MIN_ONLINE = 10;
const OPEN = new Set(['pending', 'confirmed', 'packed', 'shipped']);

/**
 * What can be paid online now: a business's advance (the rest is cash on delivery), else all that is due.
 * 0 when nothing can be paid online (paid, cancelled, delivered).
 */
export function onlineAmount(o: Pick<Order, 'status' | 'type' | 'total' | 'paidAmount' | 'advanceRequired'>) {
  if (!OPEN.has(o.status)) return 0;
  const due = paisa(o.total) - paisa(o.paidAmount);
  if (due <= 0) return 0;
  const advance = o.type === 'wholesale' ? paisa(o.advanceRequired) - paisa(o.paidAmount) : 0;
  return taka(advance > 0 ? Math.min(advance, due) : due);
}

const returnUrl = (result: 'success' | 'fail' | 'cancel') => `${env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/webhooks/sslcommerz/return/${result}`;

/**
 * Opens a payment for the order: a new try with its own transaction id, and SSLCommerz's payment page.
 * Throws a message for the shopper when it cannot be paid online now.
 */
export async function startPayment(order: Order) {
  const g = await gateway();
  if (!g) throw badRequest('Online payment is not available right now. Please choose cash on delivery.');
  const amount = onlineAmount(order);
  if (amount <= 0) throw conflict('This order has nothing to pay online.');
  if (amount < MIN_ONLINE) throw badRequest(`Online payment starts at ৳${MIN_ONLINE}. Please pay cash on delivery.`);

  const tranId = `PT${order.number}-${randomBytes(5).toString('hex')}`;
  const [attempt] = await db.insert(onlinePayments).values({ orderId: order.id, tranId, amount, sandbox: g.sandbox ? 'true' : 'false' }).returning();
  const items = await db.select({ name: orderItems.name, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.position));
  const session = await startSession(g, {
    tranId,
    amount,
    orderNumber: order.number,
    customer: { name: order.customerName, phone: order.phone, email: order.email, address: order.address, city: order.districtName },
    productNames: items.map((i) => i.name),
    items: items.reduce((n, i) => n + i.quantity, 0),
    urls: { success: returnUrl('success'), fail: returnUrl('fail'), cancel: returnUrl('cancel'), ipn: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/webhooks/sslcommerz/ipn` },
  }).catch(async (err) => {
    await db.update(onlinePayments).set({ status: 'error', reason: 'No answer from SSLCommerz' }).where(eq(onlinePayments.id, attempt!.id));
    throw err;
  });
  if (!session.ok) {
    await db.update(onlinePayments).set({ status: 'error', reason: session.reason }).where(eq(onlinePayments.id, attempt!.id));
    logger.warn({ order: order.number, tranId, reason: session.reason }, 'SSLCommerz did not start the payment');
    throw badRequest('The payment page could not be opened. Please try again, or choose cash on delivery.');
  }
  await db.update(onlinePayments).set({ sessionKey: session.sessionKey }).where(eq(onlinePayments.id, attempt!.id));
  // If the shopper's return and the IPN both go missing, look it up a little later (and once more after an hour).
  for (const minutes of [15, 75]) {
    sendJob(QUEUES.paymentCheck, { tranId }, { startAfter: minutes * 60, singletonKey: `${tranId}-${minutes}` }).catch((err) => logger.error({ err, tranId }, 'Could not queue the payment check'));
  }
  return { url: session.url, tranId, amount };
}

export type SettleResult = { result: 'paid' | 'already' | 'unknown' | 'not_valid' | 'mismatch' | 'off'; orderId?: number };

/**
 * A shopper's return or an IPN says this try was paid (val_id): checked with SSLCommerz, and if it is
 * right, the payment is added to the order. Safe to call any number of times.
 */
export async function settle(tranId: string, valId: string, via: 'return' | 'ipn' | 'check'): Promise<SettleResult> {
  const [attempt] = await db.select().from(onlinePayments).where(eq(onlinePayments.tranId, tranId));
  if (!attempt) return { result: 'unknown' };
  if (attempt.status === 'paid') return { result: 'already', orderId: attempt.orderId };
  const g = await gateway();
  // Switched off meanwhile, or sandbox/live changed: the try is kept to be checked by staff.
  if (!g || (attempt.sandbox === 'true') !== g.sandbox) return { result: 'off', orderId: attempt.orderId };

  const v = await validate(g, valId);
  const checked = { checkedAt: new Date(), details: detailsOf(v, via) };
  if ((v.status !== 'VALID' && v.status !== 'VALIDATED') || v.tranId !== attempt.tranId) {
    await db.update(onlinePayments).set(checked).where(and(eq(onlinePayments.id, attempt.id), sql`${onlinePayments.status} <> 'paid'`));
    logger.warn({ tranId, via, status: v.status, sameTran: v.tranId === attempt.tranId }, 'SSLCommerz payment not confirmed');
    return { result: 'not_valid', orderId: attempt.orderId };
  }
  if (paisa(v.amount) !== paisa(attempt.amount) || v.currency !== attempt.currency) {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(onlinePayments).where(eq(onlinePayments.id, attempt.id)).for('update');
      if (!locked || locked.status === 'paid' || locked.status === 'mismatch') return;
      await tx.update(onlinePayments).set({ ...checked, status: 'mismatch', valId: v.valId, bankTranId: v.bankTranId, reason: `Paid ${v.currency} ${v.amount}, asked BDT ${attempt.amount}` }).where(eq(onlinePayments.id, attempt.id));
      await systemNote(tx, attempt.orderId, `Online payment did not match (SSLCommerz says ${v.currency} ${v.amount}, we asked ৳${attempt.amount}; ${tranId}). Not counted: check it in SSLCommerz.`);
    });
    logger.error({ tranId, via, amount: v.amount, currency: v.currency, asked: attempt.amount }, 'SSLCommerz amount or currency mismatch');
    return { result: 'mismatch', orderId: attempt.orderId };
  }

  const done = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(onlinePayments).where(eq(onlinePayments.id, attempt.id)).for('update');
    if (!locked || locked.status === 'paid') return false;
    const risky = v.riskLevel === '1';
    const how = v.cardType ? ` by ${v.cardType}` : '';
    const { paymentId, order } = await recordSystemPayment(
      tx,
      attempt.orderId,
      { method: 'online', amount: attempt.amount, reference: v.bankTranId ?? v.valId, note: `SSLCommerz${how} (${tranId})${attempt.sandbox === 'true' ? ', test money' : ''}` },
      risky ? `SSLCommerz marked this payment as risky${v.riskTitle ? ` (${v.riskTitle})` : ''}: check it before sending.` : undefined,
    );
    if (!OPEN.has(order.status)) await systemNote(tx, attempt.orderId, `Paid online while the order was ${order.status}: refund it or open the order again.`);
    // Paid twice (two tabs), or staff took money meanwhile: the money is real, so it is counted, and staff are told.
    const over = paisa(order.paidAmount) + paisa(attempt.amount) - paisa(order.total);
    if (over > 0) await systemNote(tx, attempt.orderId, `Paid ${'৳' + taka(over).toLocaleString('en-US')} more than the total: refund it to the customer.`);
    // Never mistaken for real money, even if the sandbox is left on for a live shop.
    if (attempt.sandbox === 'true') await systemNote(tx, attempt.orderId, 'Sandbox (test) payment: no real money was received.');
    await tx
      .update(onlinePayments)
      .set({ ...checked, status: 'paid', valId: v.valId, bankTranId: v.bankTranId, cardType: v.cardType, riskLevel: v.riskLevel, paymentId, paidAt: new Date(), reason: null })
      .where(eq(onlinePayments.id, attempt.id));
    return true;
  });
  logger.info({ tranId, via, amount: attempt.amount, recorded: done }, 'SSLCommerz payment confirmed');
  return { result: done ? 'paid' : 'already', orderId: attempt.orderId };
}

/** Only what helps staff and support later; never the store's id or password. */
function detailsOf(v: Validation, via: string) {
  return { via, status: v.status, amount: v.amount, currency: v.currency, cardType: v.cardType, bankTranId: v.bankTranId, riskLevel: v.riskLevel, riskTitle: v.riskTitle, tranDate: v.tranDate };
}

/** The shopper came back without paying (failed, or left the payment page). Never undoes a payment. */
export async function markUnpaid(tranId: string, status: Extract<OnlinePaymentStatus, 'failed' | 'cancelled'>, reason: string | null) {
  const [row] = await db
    .update(onlinePayments)
    .set({ status, reason: reason?.slice(0, 300) ?? null })
    .where(and(eq(onlinePayments.tranId, tranId), eq(onlinePayments.status, 'started')))
    .returning({ orderId: onlinePayments.orderId });
  if (row) return row.orderId;
  const [any] = await db.select({ orderId: onlinePayments.orderId }).from(onlinePayments).where(eq(onlinePayments.tranId, tranId));
  return any?.orderId ?? null;
}

/**
 * Asks SSLCommerz about a try still waiting (no return, no IPN): paid tries are settled, failed ones
 * marked. At most every 30 seconds per try.
 */
export async function checkTry(tranId: string) {
  const [attempt] = await db.select().from(onlinePayments).where(eq(onlinePayments.tranId, tranId));
  if (!attempt || attempt.status !== 'started') return attempt?.status ?? null;
  if (attempt.checkedAt && Date.now() - attempt.checkedAt.getTime() < 30_000) return attempt.status;
  const g = await gateway();
  if (!g || (attempt.sandbox === 'true') !== g.sandbox) return attempt.status;
  await db.update(onlinePayments).set({ checkedAt: new Date() }).where(eq(onlinePayments.id, attempt.id));
  const found = await lookUp(g, tranId);
  const paid = found.tries.find((t) => (t.status === 'VALID' || t.status === 'VALIDATED') && t.valId);
  if (paid) return (await settle(tranId, paid.valId!, 'check')).result === 'paid' ? 'paid' : attempt.status;
  // Older than an hour and SSLCommerz knows no payment for it: it will not come any more.
  if (found.connected && Date.now() - attempt.createdAt.getTime() > 60 * 60_000) {
    await markUnpaid(tranId, 'failed', found.tries[0]?.error ?? 'Not paid');
    return 'failed';
  }
  return attempt.status;
}

/** The order's latest online try, as the thank-you page shows it. A waiting one is looked up first. */
export async function latestTry(orderId: number) {
  const [last] = await db.select().from(onlinePayments).where(eq(onlinePayments.orderId, orderId)).orderBy(desc(onlinePayments.createdAt), desc(onlinePayments.id)).limit(1);
  if (!last) return null;
  let status = last.status;
  if (status === 'started' && Date.now() - last.createdAt.getTime() > 20_000) {
    status = (await checkTry(last.tranId).catch(() => status)) ?? status;
  }
  return { status, amount: last.amount, cardType: last.cardType, sandbox: last.sandbox === 'true', at: last.paidAt ?? last.createdAt };
}
