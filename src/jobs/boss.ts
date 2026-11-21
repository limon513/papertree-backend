import { PgBoss, type SendOptions } from 'pg-boss';
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';

/**
 * Background jobs, stored in PostgreSQL (schema "pgboss"), so they work without Redis.
 * Jobs survive restarts: a job that was running when the server stopped is picked up again.
 */
export const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss', max: 3 });

boss.on('error', (err) => logger.error({ err }, 'Background job error'));

export const QUEUES = {
  /** Data: { jobId } of an import_jobs row. */
  productImport: 'product-import',
  /** Data: { orderId }. Emails after a website order (customer confirmation, shop alert). */
  orderPlaced: 'order-placed',
  /** Data: { orderId, status }. Tells the customer their order moved on (SMS / email), a minute after the change. */
  orderStatus: 'order-status',
  /** Data: { phone }. A new website order's courier record (Steadfast), unless a fresh one is saved. */
  courierCheck: 'courier-check',
  /** Data: { runId } of an old_site_runs row. Reads the old website for "Move from old site". */
  oldSiteRead: 'old-site-read',
  /** Data: { tranId }. An online payment try with no answer yet: asked from SSLCommerz a while later. */
  paymentCheck: 'payment-check',
  /** Data: { campaignId }. A push offer whose time has come: its devices are split into batches. */
  pushCampaign: 'push-campaign',
  /** Data: { campaignId, ids }. One batch of devices (up to 500) for a push offer. */
  pushBatch: 'push-batch',
  /** No data. Once a day (11 am Dhaka): saved items back in stock or cheaper, one alert per customer. */
  wishlistAlerts: 'wishlist-alerts',
  /** No data. Once a day (3 am Dhaka): customer activity older than 90 days goes. */
  activityCleanup: 'activity-cleanup',
  /** No data. Every 10 minutes (and at start): product pictures not yet ready for search by photo. */
  photoIndex: 'photo-index',
} as const;

let started: Promise<PgBoss> | null = null;

/** Starts the queue (once). Needed before sending jobs. */
export function startBoss() {
  started ??= (async () => {
    await boss.start();
    // An import can take a while (images are downloaded); allow up to 3 hours.
    // After a crash it is retried and continues where it stopped.
    await boss.createQueue(QUEUES.productImport, { expireInSeconds: 3 * 3600, retryLimit: 2, retryDelay: 30 });
    // Emails: retried a few times if something goes wrong (each email is still sent only once).
    await boss.createQueue(QUEUES.orderPlaced, { expireInSeconds: 300, retryLimit: 3, retryDelay: 60 });
    await boss.createQueue(QUEUES.orderStatus, { expireInSeconds: 300, retryLimit: 3, retryDelay: 60 });
    // Not retried: Steadfast allows few checks a day; staff can press Check now.
    await boss.createQueue(QUEUES.courierCheck, { expireInSeconds: 120, retryLimit: 0 });
    // Reading a big old site can take a while; not retried (start it again from the page instead).
    await boss.createQueue(QUEUES.oldSiteRead, { expireInSeconds: 3 * 3600, retryLimit: 0 });
    // SSLCommerz busy: tried again later (settling a payment twice changes nothing).
    await boss.createQueue(QUEUES.paymentCheck, { expireInSeconds: 120, retryLimit: 3, retryDelay: 600 });
    // Push offers: splitting is retried (it only starts once); a batch is not (no device gets it twice).
    await boss.createQueue(QUEUES.pushCampaign, { expireInSeconds: 300, retryLimit: 2, retryDelay: 60 });
    await boss.createQueue(QUEUES.pushBatch, { expireInSeconds: 900, retryLimit: 0 });
    // Daily, mid-morning in Bangladesh; one run at a time (a run that failed is tried once more).
    await boss.createQueue(QUEUES.wishlistAlerts, { expireInSeconds: 1800, retryLimit: 1, retryDelay: 600, policy: 'singleton' });
    await boss.createQueue(QUEUES.activityCleanup, { expireInSeconds: 1800, retryLimit: 1, retryDelay: 600, policy: 'singleton' });
    // One run at a time; a big catalogue is done in runs of 200 pictures.
    await boss.createQueue(QUEUES.photoIndex, { expireInSeconds: 1800, retryLimit: 1, retryDelay: 300, policy: 'singleton' });
    return boss;
  })();
  return started;
}

export async function sendJob(queue: string, data: object, options: SendOptions = {}) {
  await startBoss();
  return boss.send(queue, data, options);
}
