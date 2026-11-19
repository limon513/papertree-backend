import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { customers, messageLog, pushDevices } from '../../db/schema/index.ts';
import { logger } from '../../lib/logger.ts';
import { pushSetup, sendOne, type PushMessage, type PushSetup } from './fcm.ts';

/**
 * Push notifications to the shop's customers, with care not to annoy:
 * - only on devices where they allowed it, and only the kinds they keep on (account page);
 * - order updates follow the shop's message settings, once per order step;
 * - away from the live server (or in test mode) only test phone numbers get real alerts.
 */
export type PushKind = 'orders' | 'offers' | 'wishlist';
const PREF = { orders: customers.pushOrders, offers: customers.pushOffers, wishlist: customers.pushWishlist } as const;

/** A device allowed push (or its token changed): saved for this customer (or for no one, offers only). */
export async function registerDevice(token: string, device: string | null, customerId: number | null) {
  await db
    .insert(pushDevices)
    .values({ token, device, customerId })
    .onConflictDoUpdate({
      target: pushDevices.token,
      // A signed-in shopper takes the device over; a signed-out visit keeps whoever had it.
      set: { device, failures: 0, updatedAt: new Date(), ...(customerId !== null && { customerId }) },
    });
}

/** The device switched alerts off (or the shopper turned them off for it). */
export async function removeDevice(token: string) {
  await db.delete(pushDevices).where(eq(pushDevices.token, token));
}

/** A customer's alert choices, and how many of their devices allowed alerts. */
export async function preferencesOf(customerId: number) {
  const [c] = await db.select({ orders: customers.pushOrders, offers: customers.pushOffers, wishlist: customers.pushWishlist }).from(customers).where(eq(customers.id, customerId));
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(pushDevices).where(eq(pushDevices.customerId, customerId))) as [{ n: number }];
  return { ...c!, devices: n };
}

export async function setPreferences(customerId: number, p: Partial<Record<PushKind, boolean>>) {
  const set = { ...(p.orders !== undefined && { pushOrders: p.orders }), ...(p.offers !== undefined && { pushOffers: p.offers }), ...(p.wishlist !== undefined && { pushWishlist: p.wishlist }) };
  if (Object.keys(set).length) await db.update(customers).set(set).where(eq(customers.id, customerId));
  return preferencesOf(customerId);
}

/** One device, one message: sent, logged, and the device dropped if it is gone. Never throws. */
export async function deliver(setup: PushSetup, device: { id: number; token: string }, msg: PushMessage, purpose: string, opts: { ttlSeconds: number; urgent?: boolean; logged?: boolean }) {
  const outcome = await sendOne(setup, device.token, msg, opts);
  if (outcome.result === 'sent') await db.update(pushDevices).set({ failures: 0, lastSentAt: new Date() }).where(eq(pushDevices.id, device.id));
  else if (outcome.result === 'gone') await db.delete(pushDevices).where(eq(pushDevices.id, device.id));
  else await db.update(pushDevices).set({ failures: sql`${pushDevices.failures} + 1` }).where(eq(pushDevices.id, device.id));
  if (opts.logged !== false) {
    await db.insert(messageLog).values({
      channel: 'push',
      to: `device ${device.id}`,
      subject: msg.title,
      body: msg.body,
      status: outcome.result === 'sent' ? 'sent' : 'failed',
      provider: setup.real ? 'firebase' : 'test',
      error: outcome.result === 'failed' ? outcome.error : outcome.result === 'gone' ? 'Device no longer takes alerts (removed)' : null,
      purpose,
    });
  }
  return outcome.result;
}

/**
 * Sends to all of a customer's devices, if they keep this kind of alert on. Answers how many got it.
 * In test mode a customer who is not a test phone gets nothing: the message is only written to the log.
 */
export async function sendToCustomer(customerId: number, kind: PushKind, msg: PushMessage, purpose: string, opts: { ttlSeconds?: number; urgent?: boolean } = {}) {
  try {
    const setup = await pushSetup();
    if (!setup) return 0;
    const [c] = await db.select({ phone: customers.phone, on: PREF[kind] }).from(customers).where(eq(customers.id, customerId));
    if (!c?.on) return 0;
    const devices = await db.select({ id: pushDevices.id, token: pushDevices.token }).from(pushDevices).where(eq(pushDevices.customerId, customerId));
    if (!devices.length) return 0;
    if (setup.testOnly && !setup.testPhones.includes(c.phone)) {
      await db.insert(messageLog).values(devices.map((d) => ({ channel: 'push' as const, to: `device ${d.id}`, subject: msg.title, body: msg.body, status: 'logged' as const, provider: setup.real ? 'firebase' : 'test', purpose })));
      return 0;
    }
    let sent = 0;
    for (const d of devices) if ((await deliver(setup, d, msg, purpose, { ttlSeconds: opts.ttlSeconds ?? 86_400, urgent: opts.urgent })) === 'sent') sent++;
    return sent;
  } catch (err) {
    logger.error({ err, customerId, purpose }, 'Push notification failed');
    return 0;
  }
}

/** The customer's devices for a test from the admin. */
export const devicesOf = (customerId: number) => db.select().from(pushDevices).where(and(eq(pushDevices.customerId, customerId)));
