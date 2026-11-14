import { and, desc, eq, like, ne } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { messageLog, orders } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { sendEmail, sendSms } from '../admin/integrations/service.ts';
import type { MessageEvent, StoreSettings } from '../admin/settings/schemas.ts';
import { getSettings } from '../admin/settings/service.ts';
import { alreadySent, button, esc, itemsTable, layout, load, placeOf, site, taka, type Loaded } from './order-emails.ts';

/**
 * Messages to the customer when their order moves on: confirmed, on the way, delivered, cancelled.
 * Settings → Customer messages chooses which go out by SMS and which by email. Each goes out once
 * per order, even when staff set the same step twice.
 */

type Order = typeof orders.$inferSelect;
/** The steps after "placed" that a customer hears about. */
export type OrderUpdate = Exclude<MessageEvent, 'placed'>;
export const ORDER_UPDATES: readonly OrderUpdate[] = ['confirmed', 'shipped', 'delivered', 'cancelled'];

const round = (n: number) => Math.round(n * 100) / 100;
const dueOf = (o: Pick<Order, 'total' | 'paidAmount'>) => Math.max(0, round(o.total - o.paidAmount));

// ---- SMS: plain English letters only (Bangla letters or "৳" make every SMS cost about twice) ----

/** Keeps only letters a normal SMS can carry. */
export function smsSafe(text: string) {
  return text
    .replace(/৳/g, 'Tk ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[`{}[\]~^\\|]/g, '') // these count as two letters
    .replace(/\s+/g, ' ')
    .trim();
}

const tk = (n: number) => `Tk ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** One SMS holds 160 letters. Tries each wording, longest first, and keeps the first that fits. */
const ONE_SMS = 160;
function fit(...tries: string[]) {
  const clean = tries.map(smsSafe);
  return clean.find((t) => t.length <= ONE_SMS) ?? clean[clean.length - 1]!.slice(0, ONE_SMS);
}

type SmsOrder = Pick<Order, 'number' | 'total' | 'paidAmount' | 'courier' | 'trackingCode'>;

/** The SMS for an order step. */
export function smsText(event: MessageEvent, o: SmsOrder, store: Pick<StoreSettings, 'name' | 'phone'>) {
  const name = smsSafe(store.name) || 'PaperTree';
  const order = `order #${o.number}`;
  const due = dueOf(o);
  const call = store.phone ? ` Questions? Call ${store.phone}.` : '';
  switch (event) {
    case 'placed':
      return fit(`${name}: We got your ${order} (${tk(o.total)}). We will call you soon to confirm it. Thank you!`, `${name}: We got your ${order}. We will call you soon.`);
    case 'confirmed': {
      const pay = due <= 0 ? `Total ${tk(o.total)}, paid.` : due < o.total ? `Pay ${tk(due)} on delivery.` : `Total ${tk(o.total)}, pay on delivery.`;
      return fit(`${name}: Your ${order} is confirmed. ${pay} We will send it soon. Thank you!`, `${name}: Your ${order} is confirmed. ${pay}`);
    }
    case 'shipped': {
      const courier = smsSafe(o.courier ?? '');
      const tracking = smsSafe(o.trackingCode ?? '');
      const how = `${courier ? ` with ${courier}` : ''}${tracking ? `, tracking ${tracking}` : ''}`;
      const pay = due > 0 ? ` Please keep ${tk(due)} ready.` : '';
      return fit(
        `${name}: Your ${order} is on the way${how}.${pay}`,
        `${name}: Your ${order} is on the way${courier ? ` with ${courier}` : ''}.${pay}`,
        `${name}: Your ${order} is on the way.${pay}`,
      );
    }
    case 'delivered':
      return fit(`${name}: Your ${order} is delivered. Thank you for shopping with us!`);
    case 'cancelled':
      return fit(`${name}: Your ${order} is cancelled.${call}`, `${name}: Your ${order} is cancelled.`);
  }
}

// ---- Emails ----

const SUBJECT: Record<OrderUpdate, string> = {
  confirmed: 'is confirmed',
  shipped: 'is on the way',
  delivered: 'is delivered',
  cancelled: 'is cancelled',
};

export function statusEmail(event: OrderUpdate, d: Loaded) {
  const o = d.order;
  const first = o.customerName.split(' ')[0] ?? o.customerName;
  const due = dueOf(o);
  const place = placeOf(o);
  const phone = d.store.phone;
  const link = o.publicToken ? `${site()}/checkout/thank-you/?o=${encodeURIComponent(o.publicToken)}` : null;
  const p = (html: string) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.55">${html}</p>`;
  const help = `<p style="font-size:13px;color:#71717a;margin-top:16px">Questions? Reply to this email${phone ? ` or call ${esc(phone)}` : ''}.</p>`;
  const payLine =
    due <= 0
      ? 'It is fully paid.'
      : due < o.total
        ? `You paid ${taka(round(o.paidAmount))}; please pay the remaining <strong>${taka(due)}</strong> when it arrives.`
        : `Please pay <strong>${taka(due)}</strong> in cash when it arrives.`;
  const payText = payLine.replace(/<[^>]+>/g, '');

  let body: string;
  let text: string[];
  switch (event) {
    case 'confirmed':
      body =
        p(`Thank you, ${esc(first)}. We are getting your order ready and will send it to <strong>${esc(place)}</strong>${d.deliveryTime ? `, usually in <strong>${esc(d.deliveryTime)}</strong>` : ''}.`) +
        p(payLine) +
        itemsTable(d, due <= 0 ? 'Total (paid)' : 'Total');
      text = [
        `Thank you, ${first}. We are getting your order ready and will send it to ${place}${d.deliveryTime ? `, usually in ${d.deliveryTime}` : ''}.`,
        payText,
        '',
        ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ''}: ${taka(i.lineTotal)}`),
        `Total: ${taka(o.total)}`,
      ];
      break;
    case 'shipped': {
      const how = o.courier ? ` with <strong>${esc(o.courier)}</strong>` : '';
      body =
        p(`Good news, ${esc(first)}: your order is on the way${how} to <strong>${esc(place)}</strong>.`) +
        (o.trackingCode ? p(`Tracking code: <strong>${esc(o.trackingCode)}</strong>`) : '') +
        p(payLine);
      text = [`Good news, ${first}: your order is on the way${o.courier ? ` with ${o.courier}` : ''} to ${place}.`, ...(o.trackingCode ? [`Tracking code: ${o.trackingCode}`] : []), payText];
      break;
    }
    case 'delivered':
      body = p(`Thank you for shopping with ${esc(d.store.name)}, ${esc(first)}! We hope you enjoy your order.`) + p('If anything is wrong with it, tell us and we will make it right.');
      text = [`Thank you for shopping with ${d.store.name}, ${first}! We hope you enjoy your order.`, 'If anything is wrong with it, tell us and we will make it right.'];
      break;
    case 'cancelled': {
      const paid = o.paidAmount > 0 ? ` You paid ${taka(round(o.paidAmount))}: we will contact you about the money.` : '';
      body = p(`Your order #${o.number} is cancelled, ${esc(first)}.${paid}`) + p('If this is a mistake, just reply or call us and we will sort it out.');
      text = [`Your order #${o.number} is cancelled, ${first}.${paid}`, 'If this is a mistake, just reply or call us and we will sort it out.'];
      break;
    }
  }
  const title = `Your order #${o.number} ${SUBJECT[event]}`;
  const html = layout(d, title, body + (link && event !== 'cancelled' ? button(link, 'See your order') : '') + help);
  return {
    subject: `Order #${o.number} ${SUBJECT[event]}`,
    html,
    text: [title, '', ...text, ...(link && event !== 'cancelled' ? ['', `See your order: ${link}`] : []), '', `Questions? Reply to this email${phone ? ` or call ${phone}` : ''}.`].join('\n'),
  };
}

// ---- Sending ----

/**
 * Tells the customer about an order step (the background job calls this, a minute after the change).
 * Skipped when the order has moved on since: a wrong click that staff undid never reaches the customer.
 */
export async function sendOrderUpdate(orderId: number, event: OrderUpdate) {
  const d = await load(orderId);
  if (!d) return;
  const o = d.order;
  if (o.status !== event) {
    logger.info({ order: o.number, event, now: o.status }, 'Order message skipped: the order moved on');
    return;
  }
  const choice = (await getSettings('messages'))[event];
  const purpose = `order.${event} #${o.number}`;
  if (choice.sms && o.phone && !(await alreadySent(purpose, 'sms'))) {
    await sendSms({ to: o.phone, text: smsText(event, o, d.store), purpose });
  }
  if (choice.email && o.email && !(await alreadySent(purpose, 'email'))) {
    await sendEmail({ to: o.email, ...statusEmail(event, d), purpose });
  }
}

/**
 * Tells the customer about a status change, a minute later (time to undo a wrong click). Steps they
 * do not hear about (packed, returned) are ignored. Never throws.
 */
export function queueOrderUpdate(orderId: number, status: string) {
  if (!(ORDER_UPDATES as readonly string[]).includes(status)) return;
  sendJob(QUEUES.orderStatus, { orderId, status }, { startAfter: env.ORDER_MESSAGE_DELAY }).catch((err) =>
    logger.error({ err, order: orderId }, 'Could not queue the customer message'),
  );
}

/** The "order placed" SMS (the email goes with the shop's alert, in order-emails). */
export async function sendPlacedSms(orderId: number) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o?.phone) return;
  const purpose = `order.placed #${o.number}`;
  const [messages, store] = await Promise.all([getSettings('messages'), getSettings('store')]);
  if (!messages.placed.sms || (await alreadySent(purpose, 'sms'))) return;
  await sendSms({ to: o.phone, text: smsText('placed', o, store), purpose });
}

/** Messages sent to the customer about one order (not the shop's own alert), newest first. */
export const orderMessagesOf = (number: number) =>
  db
    .select({ id: messageLog.id, channel: messageLog.channel, purpose: messageLog.purpose, to: messageLog.to, status: messageLog.status, error: messageLog.error, createdAt: messageLog.createdAt })
    .from(messageLog)
    .where(and(like(messageLog.purpose, `order.% #${number}`), ne(messageLog.purpose, `order.alert #${number}`)))
    .orderBy(desc(messageLog.createdAt), desc(messageLog.id));

/** Example SMS for Settings → Customer messages (a made-up order). */
export function sampleSms(store: Pick<StoreSettings, 'name' | 'phone'>) {
  const o: SmsOrder = { number: 100123, total: 1240, paidAmount: 0, courier: 'Steadfast', trackingCode: 'SF12345678' };
  const events = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
  return Object.fromEntries(events.map((e) => [e, smsText(e, o, store)])) as Record<MessageEvent, string>;
}
