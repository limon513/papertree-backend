import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { adminUsers, customers, pushCampaigns, pushDevices } from '../../db/schema/index.ts';
import { QUEUES, sendJob } from '../../jobs/boss.ts';
import { badRequest, conflict, notFound } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { imagesById } from '../store/catalog.ts';
import { pushSetup, sendOne, type PushMessage } from './fcm.ts';
import { deliver } from './service.ts';

/**
 * Offers and news by push, to everyone who keeps offers on. Care not to annoy:
 * - never at night in Bangladesh: a message for 10 pm–8 am goes out at 8 am;
 * - at least 6 hours between offers.
 * Sending is split into batches of 500 devices for the background workers (several processes can
 * share the work), each sending 20 at a time, so even 100,000+ devices go out steadily.
 */
export const QUIET_FROM = 22;
export const QUIET_UNTIL = 8;
export const MIN_GAP_HOURS = 6;
const BATCH = 500;
const AT_ONCE = 20;
const DHAKA = 6 * 3600_000; // Bangladesh has no summer time.

/** Out of night hours: the same moment, or 8 am Dhaka time. */
export function outOfNight(at: Date) {
  const local = new Date(at.getTime() + DHAKA);
  const h = local.getUTCHours();
  if (h >= QUIET_UNTIL && h < QUIET_FROM) return at;
  const morning = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), QUIET_UNTIL) - DHAKA);
  return h >= QUIET_FROM ? new Date(morning.getTime() + 86_400_000) : morning;
}

/** When it can go: not at night, and not within 6 hours of another offer (else a message saying when). */
async function sendTime(requested: Date | null) {
  const now = new Date();
  const at = outOfNight(requested && requested > now ? requested : now);
  const gap = MIN_GAP_HOURS * 3600_000;
  const [near] = await db
    .select({ sendAt: pushCampaigns.sendAt, title: pushCampaigns.title })
    .from(pushCampaigns)
    .where(and(ne(pushCampaigns.status, 'cancelled'), sql`abs(extract(epoch from (${pushCampaigns.sendAt} - ${at.toISOString()}::timestamptz))) < ${gap / 1000}`))
    .orderBy(desc(pushCampaigns.sendAt))
    .limit(1);
  if (near) {
    const earliest = outOfNight(new Date(near.sendAt.getTime() + gap));
    throw conflict(`“${near.title}” goes out ${dhakaTime(near.sendAt)}. Offers need ${MIN_GAP_HOURS} hours between them: the earliest is ${dhakaTime(earliest)}.`, { earliest: earliest.toISOString() });
  }
  return at;
}

/** "19 Nov, 8:00 pm" in Dhaka time. */
export const dhakaTime = (d: Date) =>
  d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).replace(' am', ' am').replace(' pm', ' pm');

/** Devices an offer would reach: any device whose owner keeps offers on (or has no account). Test mode: test phones only. */
async function audienceWhere() {
  const setup = await pushSetup();
  if (!setup) return null;
  const offersOn = or(isNull(pushDevices.customerId), eq(customers.pushOffers, true));
  return { setup, where: setup.testOnly ? and(offersOn, inArray(customers.phone, setup.testPhones.length ? setup.testPhones : ['-'])) : offersOn };
}

export async function audienceSize() {
  const a = await audienceWhere();
  if (!a) return { devices: 0, ready: false, testMode: false };
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(pushDevices).leftJoin(customers, eq(customers.id, pushDevices.customerId)).where(a.where)) as [{ n: number }];
  return { devices: n, ready: true, testMode: a.setup.testOnly };
}

export interface CampaignInput {
  title: string;
  body: string;
  url: string;
  imageId: number | null;
  /** null: as soon as allowed. */
  sendAt: Date | null;
}

/** Plan an offer: when it goes (night and gap rules), then the queue starts it at that time. */
export async function createCampaign(input: CampaignInput, adminUserId: number) {
  if (!(await pushSetup())) throw badRequest('Push notifications are off or not set up yet (Integrations).');
  const sendAt = await sendTime(input.sendAt);
  const [row] = await db.insert(pushCampaigns).values({ ...input, sendAt, createdBy: adminUserId }).returning();
  await sendJob(QUEUES.pushCampaign, { campaignId: row!.id }, { startAfter: sendAt, singletonKey: `push-campaign-${row!.id}` });
  return row!;
}

/** Stop an offer that has not started going out. */
export async function cancelCampaign(id: number) {
  const [row] = await db.update(pushCampaigns).set({ status: 'cancelled' }).where(and(eq(pushCampaigns.id, id), eq(pushCampaigns.status, 'scheduled'))).returning();
  if (!row) throw conflict('Only an offer that has not started going out can be cancelled.');
  return row;
}

async function messageOf(c: typeof pushCampaigns.$inferSelect): Promise<PushMessage> {
  const image = c.imageId ? (await imagesById([c.imageId])).get(c.imageId) : null;
  const urls = image?.urls ?? {};
  const big = Object.keys(urls).map(Number).filter((w) => w <= 1024).sort((a, b) => b - a)[0];
  return {
    title: c.title,
    body: c.body,
    url: c.url,
    tag: `offer-${c.id}`,
    image: big ? urls[String(big)] : null,
    id: String(c.id),
    tap: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/store/push/tapped?c=${c.id}`,
  };
}

/** The offer's time has come: its devices are split into batches for the workers. */
export async function startCampaign(campaignId: number) {
  const [c] = await db.select().from(pushCampaigns).where(eq(pushCampaigns.id, campaignId));
  if (!c || c.status !== 'scheduled') return;
  // Moved or not due yet (a job that woke early): it comes again at its time.
  if (c.sendAt.getTime() > Date.now() + 60_000) return;
  const a = await audienceWhere();
  if (!a) {
    await db.update(pushCampaigns).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(pushCampaigns.id, c.id));
    logger.warn({ campaign: c.id }, 'Push offer not sent: push is off');
    return;
  }
  const [claimed] = await db.update(pushCampaigns).set({ status: 'sending', startedAt: new Date() }).where(and(eq(pushCampaigns.id, c.id), eq(pushCampaigns.status, 'scheduled'))).returning();
  if (!claimed) return;
  let after = 0;
  let batches = 0;
  let targeted = 0;
  for (;;) {
    const ids = (
      await db
        .select({ id: pushDevices.id })
        .from(pushDevices)
        .leftJoin(customers, eq(customers.id, pushDevices.customerId))
        .where(and(a.where, gt(pushDevices.id, after)))
        .orderBy(pushDevices.id)
        .limit(BATCH)
    ).map((r) => r.id);
    if (!ids.length) break;
    after = ids.at(-1)!;
    batches++;
    targeted += ids.length;
    await sendJob(QUEUES.pushBatch, { campaignId: c.id, ids });
  }
  // Batches may have finished already: the offer is "sent" here when all of them are done (in one step).
  await db
    .update(pushCampaigns)
    .set({
      targeted,
      batches,
      status: sql`case when ${pushCampaigns.batchesDone} >= ${batches} then 'sent' else ${pushCampaigns.status} end`,
      finishedAt: sql`case when ${pushCampaigns.batchesDone} >= ${batches} then now() else ${pushCampaigns.finishedAt} end`,
    })
    .where(eq(pushCampaigns.id, c.id));
  logger.info({ campaign: c.id, targeted, batches }, 'Push offer started');
}

/** One batch: sent 20 at a time; the counts are added to the offer, which is "sent" after its last batch. */
export async function sendBatch(campaignId: number, ids: number[]) {
  const [c] = await db.select().from(pushCampaigns).where(eq(pushCampaigns.id, campaignId));
  const setup = await pushSetup();
  const tally = { sent: 0, failed: 0, removed: 0 };
  if (c && setup && c.status === 'sending') {
    const msg = await messageOf(c);
    const devices = await db.select({ id: pushDevices.id, token: pushDevices.token }).from(pushDevices).where(inArray(pushDevices.id, ids));
    tally.failed += ids.length - devices.length; // removed meanwhile
    const outcome: Record<'sent' | 'gone' | 'failed', number[]> = { sent: [], gone: [], failed: [] };
    for (let i = 0; i < devices.length; i += AT_ONCE) {
      const part = devices.slice(i, i + AT_ONCE);
      const results = await Promise.all(part.map((d) => sendOne(setup, d.token, msg, { ttlSeconds: 2 * 86_400 })));
      results.forEach((r, k) => outcome[r.result].push(part[k]!.id));
    }
    // The devices' bookkeeping in three writes per batch, not one per device (100,000+ devices).
    if (outcome.sent.length) await db.update(pushDevices).set({ failures: 0, lastSentAt: new Date() }).where(inArray(pushDevices.id, outcome.sent));
    if (outcome.gone.length) await db.delete(pushDevices).where(inArray(pushDevices.id, outcome.gone));
    if (outcome.failed.length) await db.update(pushDevices).set({ failures: sql`${pushDevices.failures} + 1` }).where(inArray(pushDevices.id, outcome.failed));
    tally.sent += outcome.sent.length;
    tally.removed += outcome.gone.length;
    tally.failed += outcome.failed.length;
  }
  const [after] = await db
    .update(pushCampaigns)
    .set({
      sent: sql`${pushCampaigns.sent} + ${tally.sent}`,
      failed: sql`${pushCampaigns.failed} + ${tally.failed}`,
      removed: sql`${pushCampaigns.removed} + ${tally.removed}`,
      batchesDone: sql`${pushCampaigns.batchesDone} + 1`,
    })
    .where(eq(pushCampaigns.id, campaignId))
    .returning({ done: pushCampaigns.batchesDone, batches: pushCampaigns.batches, status: pushCampaigns.status });
  if (after && after.status === 'sending' && after.batches > 0 && after.done >= after.batches) {
    await db.update(pushCampaigns).set({ status: 'sent', finishedAt: new Date() }).where(eq(pushCampaigns.id, campaignId));
  }
}

/** A device reported a tap on an offer. */
export async function countTap(campaignId: number) {
  await db.update(pushCampaigns).set({ taps: sql`${pushCampaigns.taps} + 1` }).where(and(eq(pushCampaigns.id, campaignId), inArray(pushCampaigns.status, ['sending', 'sent'])));
}

/** Offers for the admin, newest first, with who wrote them. */
export async function campaignList() {
  const rows = await db
    .select({ c: pushCampaigns, by: adminUsers.name })
    .from(pushCampaigns)
    .leftJoin(adminUsers, eq(adminUsers.id, pushCampaigns.createdBy))
    .orderBy(desc(pushCampaigns.sendAt), desc(pushCampaigns.id))
    .limit(50);
  const images = await imagesById(rows.map((r) => r.c.imageId));
  return rows.map(({ c, by }) => ({ ...c, image: c.imageId ? (images.get(c.imageId) ?? null) : null, createdByName: by }));
}

/** A test to one customer's devices (by phone), before sending to everyone. */
export async function sendTest(input: Omit<CampaignInput, 'sendAt'>, customerId: number) {
  const setup = await pushSetup();
  if (!setup) throw badRequest('Push notifications are off or not set up yet (Integrations).');
  const devices = await db.select({ id: pushDevices.id, token: pushDevices.token }).from(pushDevices).where(eq(pushDevices.customerId, customerId));
  if (!devices.length) throw notFound('No device has alerts on for this number.');
  const msg = await messageOf({ id: 0, ...input, status: 'scheduled' } as typeof pushCampaigns.$inferSelect);
  let sent = 0;
  for (const d of devices) if ((await deliver(setup, d, { ...msg, id: '', tap: '', tag: 'offer-test' }, 'offer.test', { ttlSeconds: 3600 })) === 'sent') sent++;
  return { sent, devices: devices.length };
}
