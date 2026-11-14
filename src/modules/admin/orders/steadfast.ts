import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { env, isProduction } from '../../../config/env.ts';
import { db } from '../../../db/client.ts';
import { orderEvents, orderItems, orders } from '../../../db/schema/index.ts';
import { badRequest } from '../../../lib/errors.ts';
import { logger } from '../../../lib/logger.ts';
import { queueOrderUpdate } from '../../store/order-updates.ts';
import { getIntegration } from '../integrations/service.ts';
import { setStatus } from './service.ts';

/**
 * Steadfast courier. Staff send ready orders from the admin (one click for many); each becomes a
 * Steadfast parcel and the order keeps its consignment id and tracking code. Steadfast reports the
 * parcel's progress to our webhook (or staff press "Refresh"); "delivered" can mark the order
 * delivered and record the cash the rider collected.
 *
 * Real parcels: away from the live server the real Steadfast is never called (tests use a fake one).
 */

const REAL_URL = 'https://portal.packzy.com/api/v1';
const round = (n: number) => Math.round(n * 100) / 100;

/** Steadfast's parcel statuses, in words for staff. */
export const COURIER_STATUS: Record<string, string> = {
  in_review: 'Waiting for Steadfast to accept',
  pending: 'With Steadfast, on the way',
  hold: 'On hold at Steadfast',
  delivered_approval_pending: 'Delivered (Steadfast checking)',
  partial_delivered_approval_pending: 'Partly delivered (Steadfast checking)',
  cancelled_approval_pending: 'Cancelled (Steadfast checking)',
  unknown_approval_pending: 'Unknown (Steadfast checking)',
  delivered: 'Delivered',
  partial_delivered: 'Partly delivered',
  cancelled: 'Cancelled, coming back',
  exceptional: 'Lost or damaged (contact Steadfast)',
  unknown: 'Unknown',
};

/** Orders that can be sent: confirmed or packed. */
const READY = ['confirmed', 'packed'] as const;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
  const { settings, secrets } = await getIntegration('steadfast');
  if (!settings.enabled) throw badRequest('Steadfast is switched off (Integrations → Steadfast).');
  if (!secrets.apiKey || !secrets.secretKey) throw badRequest('Add the Steadfast API key and secret key first (Integrations → Steadfast).');
  const base = env.STEADFAST_URL.replace(/\/$/, '');
  if (!isProduction && base === REAL_URL && !env.STEADFAST_ALLOW_REAL) {
    throw badRequest('This is not the live server: real Steadfast parcels are not made from here.');
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Api-Key': secrets.apiKey, 'Secret-Key': secrets.secretKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, httpStatus: res.status, data };
  } catch (err) {
    return { ok: false, httpStatus: 0, data: null as T | null, error: `Could not reach Steadfast: ${(err as Error).message}` };
  }
}

/** Steadfast's answer when something is wrong, in one line. */
function problem(data: { message?: string; errors?: Record<string, string[] | string> } | null, httpStatus: number, fallback?: string) {
  const first = data?.errors ? Object.values(data.errors).flat()[0] : null;
  if (httpStatus === 401) return 'Steadfast did not accept the API keys (check Integrations → Steadfast).';
  if (httpStatus === 429) return 'Steadfast says too many tries: wait, and check the keys (10 wrong tries lock them for an hour).';
  if (httpStatus === 403) return 'Steadfast refused: the account is inactive or its details need resubmitting.';
  return first ?? data?.message ?? fallback ?? `Steadfast said no (${httpStatus || 'no answer'}).`;
}

// ---- Sending orders ----

interface CreateAnswer {
  status?: number;
  message?: string;
  errors?: Record<string, string[] | string>;
  consignment?: { consignment_id?: number | string; tracking_code?: string; tracking_link?: string; status?: string };
}

export interface SendResult {
  id: number;
  number: number | null;
  ok: boolean;
  consignmentId?: string;
  trackingCode?: string;
  cod?: number;
  /** Why it was not sent (or a warning after it was). */
  message: string | null;
}

/**
 * Sends orders to Steadfast, one parcel each. Each order is claimed first, so two staff (or a double
 * click) can never make two parcels for one order. COD: what the customer still owes.
 */
export async function sendToSteadfast(ids: number[], opts: { markShipped: boolean; notify: boolean }, adminUserId: number) {
  // Fail early (and once) when Steadfast is not set up.
  const { settings, secrets } = await getIntegration('steadfast');
  if (!settings.enabled || !secrets.apiKey || !secrets.secretKey) {
    throw badRequest(!settings.enabled ? 'Steadfast is switched off (Integrations → Steadfast).' : 'Add the Steadfast API key and secret key first (Integrations → Steadfast).');
  }
  const rows = await db.select().from(orders).where(inArray(orders.id, ids)).orderBy(asc(orders.number));
  const results: SendResult[] = ids.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ id, number: null, ok: false, message: 'Order not found' }));
  const items = await db
    .select({ orderId: orderItems.orderId, name: orderItems.name, label: orderItems.variantLabel, quantity: orderItems.quantity })
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
    .orderBy(asc(orderItems.position));

  // A few at a time: quick for 50 orders, gentle on Steadfast. Wrong keys stop the rest at once:
  // Steadfast locks the keys for an hour after 10 failures in 5 minutes.
  const queue = [...rows];
  let refused: string | null = null;
  const worker = async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      if (refused) {
        results.push({ id: o.id, number: o.number, ok: false, message: `Not tried: ${refused}` });
        continue;
      }
      const r = await sendOne(o, items.filter((i) => i.orderId === o!.id), settings.sendItems, opts, adminUserId);
      if (r.keysRefused) refused = r.message;
      results.push({ id: r.id, number: r.number, ok: r.ok, consignmentId: r.consignmentId, trackingCode: r.trackingCode, cod: r.cod, message: r.message });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return results.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

async function sendOne(
  o: typeof orders.$inferSelect,
  items: { name: string; label: string | null; quantity: number }[],
  sendItems: boolean,
  opts: { markShipped: boolean; notify: boolean },
  adminUserId: number,
): Promise<SendResult & { keysRefused?: boolean }> {
  const base = { id: o.id, number: o.number };
  if (o.consignmentId) return { ...base, ok: false, message: `Already sent (consignment ${o.consignmentId})` };
  if (!(READY as readonly string[]).includes(o.status)) return { ...base, ok: false, message: `Only confirmed or packed orders can be sent (this one is ${o.status})` };
  if (o.advanceRequired > o.paidAmount) return { ...base, ok: false, message: `The advance (৳${o.advanceRequired}) is not paid yet` };

  // Claim it: nobody else can send it while this runs (a stuck claim frees itself after 2 minutes).
  const [claimed] = await db
    .update(orders)
    .set({ courierStatus: 'sending', courierStatusAt: new Date() })
    .where(
      and(
        eq(orders.id, o.id),
        isNull(orders.consignmentId),
        inArray(orders.status, [...READY]),
        or(sql`${orders.courierStatus} is distinct from 'sending'`, sql`${orders.courierStatusAt} < now() - interval '2 minutes'`),
      ),
    )
    .returning({ id: orders.id });
  if (!claimed) return { ...base, ok: false, message: 'Someone is sending this order right now' };
  const release = () => db.update(orders).set({ courierStatus: null, courierStatusAt: null }).where(and(eq(orders.id, o.id), eq(orders.courierStatus, 'sending')));

  const cod = Math.max(0, round(o.total - o.paidAmount));
  const what = items.map((i) => `${i.quantity}x ${i.name}${i.label ? ` (${i.label})` : ''}`).join(', ');
  const parcel = {
    invoice: String(o.number),
    recipient_name: o.customerName.slice(0, 100),
    recipient_phone: o.phone,
    recipient_address: [o.address, o.areaName, o.districtName].filter(Boolean).join(', ').slice(0, 490),
    cod_amount: cod,
    note: o.customerNote ? o.customerNote.slice(0, 480) : undefined,
    item_description: sendItems && what ? what.slice(0, 255) : undefined,
    total_lot: items.reduce((n, i) => n + i.quantity, 0) || 1,
    delivery_type: 0,
  };
  // A setup problem (switched off, no keys, not the live server) comes back as this order's message.
  const answer = await call<CreateAnswer>('POST', '/create_order', parcel).catch((err: Error) => ({ ok: false, httpStatus: 0, data: null, error: err.message }));
  const c = answer.data?.consignment;
  if (!answer.ok || answer.data?.status !== 200 || !c?.consignment_id) {
    await release();
    const why = 'error' in answer && answer.error ? answer.error : problem(answer.data, answer.httpStatus);
    logger.warn({ order: o.number, status: answer.httpStatus, answer: answer.data }, 'Steadfast did not take the order');
    return { ...base, ok: false, message: why, keysRefused: answer.httpStatus === 401 || answer.httpStatus === 429 || answer.httpStatus === 403 };
  }

  const consignmentId = String(c.consignment_id);
  const trackingCode = c.tracking_code ?? null;
  const trackingUrl = typeof c.tracking_link === 'string' && /^https:\/\/[^\s]+$/.test(c.tracking_link) ? c.tracking_link.slice(0, 300) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ consignmentId, trackingCode, trackingUrl, courier: 'Steadfast', courierStatus: c.status ?? 'in_review', courierStatusAt: new Date(), courierSentAt: new Date() })
      .where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({
      orderId: o.id,
      type: 'courier',
      message: `Sent to Steadfast: consignment ${consignmentId}${trackingCode ? `, tracking ${trackingCode}` : ''}, cash to collect ৳${cod.toLocaleString('en-US')}`,
      adminUserId,
    });
  });

  let message: string | null = null;
  if (opts.markShipped) {
    try {
      await setStatus(o.id, { status: 'shipped', note: null, courier: 'Steadfast', trackingCode, collectDue: false }, adminUserId);
      if (opts.notify) queueOrderUpdate(o.id, 'shipped');
    } catch (err) {
      message = `Sent, but not marked shipped: ${(err as Error).message}`;
    }
  }
  return { ...base, ok: true, consignmentId, trackingCode: trackingCode ?? undefined, cod, message };
}

// ---- Parcel progress ----

/**
 * Saves a parcel status from Steadfast (webhook or refresh). "delivered" can finish the order: marked
 * delivered, the cash the rider collected recorded, the customer told. Returns what changed.
 */
export async function applyCourierStatus(orderId: number, status: string, adminUserId: number | null, via: 'webhook' | 'refresh') {
  const clean = status.trim().toLowerCase();
  if (!COURIER_STATUS[clean]) return { changed: false, note: `Unknown Steadfast status "${status.slice(0, 40)}"` };
  const changed = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o || o.courierStatus === clean) return false;
    await tx.update(orders).set({ courierStatus: clean, courierStatusAt: new Date() }).where(eq(orders.id, orderId));
    await tx.insert(orderEvents).values({ orderId, type: 'courier', message: `Steadfast: ${COURIER_STATUS[clean]}${via === 'refresh' ? ' (checked)' : ''}`, adminUserId });
    return true;
  });
  if (!changed) return { changed: false, note: null };

  const { settings } = await getIntegration('steadfast');
  if (clean === 'delivered' && settings.autoDeliver) {
    const [o] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    try {
      if (o && (READY as readonly string[]).includes(o.status)) {
        await setStatus(orderId, { status: 'shipped', note: 'Steadfast delivered it', courier: 'Steadfast', collectDue: false }, adminUserId);
      }
      if (o && o.status !== 'delivered' && o.status !== 'cancelled' && o.status !== 'returned') {
        await setStatus(orderId, { status: 'delivered', note: 'Delivered by Steadfast', collectDue: true }, adminUserId);
        queueOrderUpdate(orderId, 'delivered');
      }
    } catch (err) {
      logger.warn({ err, order: orderId }, 'Steadfast delivered, but the order could not be marked delivered');
      return { changed: true, note: `Saved, but the order could not be marked delivered: ${(err as Error).message}` };
    }
  }
  return { changed: true, note: null };
}

/** Asks Steadfast for a parcel's status now. */
export async function refreshCourierStatus(orderId: number, adminUserId: number) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o?.consignmentId) throw badRequest('This order was not sent with Steadfast.');
  const answer = await call<{ status?: number; delivery_status?: string; message?: string }>('GET', `/status_by_cid/${encodeURIComponent(o.consignmentId)}`);
  if (!answer.ok || !answer.data?.delivery_status) {
    throw badRequest('error' in answer && answer.error ? answer.error : problem(answer.data, answer.httpStatus, 'Steadfast did not give a status.'));
  }
  return { status: answer.data.delivery_status, ...(await applyCourierStatus(orderId, answer.data.delivery_status, adminUserId, 'refresh')) };
}

/** Money left on the Steadfast account (free: nothing is sent, so it also checks the keys). */
export async function steadfastBalance() {
  try {
    const answer = await call<{ status?: number; current_balance?: number; message?: string }>('GET', '/get_balance');
    if (answer.ok && answer.data?.status === 200) return { ok: true as const, balance: Number(answer.data.current_balance ?? 0) };
    return { ok: false as const, message: 'error' in answer && answer.error ? answer.error : problem(answer.data, answer.httpStatus) };
  } catch (err) {
    return { ok: false as const, message: (err as Error).message };
  }
}

// ---- Webhook ----

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Is this really Steadfast? Both the Bearer token and the signature (HMAC-SHA256 of the raw body,
 * hex, keyed with the token) must match. Switched off or no token: nobody is.
 */
export async function webhookAllowed(authorization: string | undefined, signature: string | undefined, raw: Buffer) {
  const { settings } = await getIntegration('steadfast');
  const token = settings.webhookToken ?? '';
  if (!settings.enabled || token.length < 20) return false;
  const given = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim() ?? '';
  if (!same(given, token)) return false;
  const expected = createHmac('sha256', token).update(raw).digest('hex');
  return same((signature ?? '').trim().toLowerCase(), expected);
}

/** The order of a Steadfast parcel: by consignment id, else by invoice (= our order number). */
async function orderOfParcel(body: Record<string, unknown>) {
  const consignment = body.consignment_id === undefined || body.consignment_id === null ? '' : String(body.consignment_id).trim();
  const invoice = typeof body.invoice === 'string' || typeof body.invoice === 'number' ? String(body.invoice).trim() : '';
  const [o] = consignment
    ? await db.select({ id: orders.id }).from(orders).where(eq(orders.consignmentId, consignment))
    : /^\d{1,12}$/.test(invoice)
      ? await db.select({ id: orders.id }).from(orders).where(and(eq(orders.number, Number(invoice)), sql`${orders.consignmentId} is not null`))
      : [];
  return o ?? null;
}

/** Steadfast's tracking text ("Your package has been delivered successfully."), kept short and plain. */
const trackingText = (body: Record<string, unknown>) =>
  typeof body.tracking_message === 'string' ? body.tracking_message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

/** Other events, in words for the order's history. */
const OTHER_EVENTS: Record<string, string> = {
  consignment_update: 'Steadfast: parcel details changed',
  cancel_request: 'Steadfast: cancellation request',
  return_request: 'Steadfast: return request',
};

/**
 * One event from Steadfast. delivery_status: the parcel's status (may finish the order);
 * tracking_update: a step in its journey (kept in the order's history, shown when tracking);
 * a few others are noted in the history. The rest are about the account and are ignored.
 * The same event twice changes nothing.
 */
export async function steadfastEvent(body: Record<string, unknown>) {
  const type = typeof body.notification_type === 'string' ? body.notification_type : 'delivery_status';
  const known = type === 'delivery_status' || type === 'tracking_update' || type in OTHER_EVENTS;
  if (!known) return { found: true, message: 'Not about a parcel (ignored)' };
  const o = await orderOfParcel(body);
  if (!o) return { found: false, message: 'No order has this parcel.' };

  if (type === 'delivery_status') {
    const status = typeof body.status === 'string' ? body.status : typeof body.delivery_status === 'string' ? body.delivery_status : '';
    if (!status) return { found: true, message: 'No status (nothing to do)' };
    const result = await applyCourierStatus(o.id, status, null, 'webhook');
    const text = trackingText(body);
    if (text) await noteOnce(o.id, `Steadfast: ${text}`);
    return { found: true, message: result.note ?? (result.changed ? 'Saved' : 'No change') };
  }
  const text = type === 'tracking_update' ? trackingText(body) : '';
  const message = type === 'tracking_update' ? (text ? `Steadfast: ${text}` : '') : `${OTHER_EVENTS[type]}${trackingText(body) ? `: ${trackingText(body)}` : ''}`;
  if (!message) return { found: true, message: 'Nothing to note' };
  const added = await noteOnce(o.id, message);
  return { found: true, message: added ? 'Noted' : 'Already noted' };
}

/** Adds a courier line to the order's history, unless its latest courier line already says this. */
async function noteOnce(orderId: number, message: string) {
  const [last] = await db
    .select({ message: orderEvents.message })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, 'courier')))
    .orderBy(sql`${orderEvents.createdAt} desc, ${orderEvents.id} desc`)
    .limit(1);
  if (last?.message === message) return false;
  await db.insert(orderEvents).values({ orderId, type: 'courier', message, adminUserId: null });
  return true;
}
