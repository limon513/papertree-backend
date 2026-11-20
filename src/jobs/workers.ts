import { logger } from '../lib/logger.ts';
import { runImport } from '../modules/admin/imports/run.ts';
import { readOldSite } from '../modules/admin/migration/reader.ts';
import { sendOrderEmails } from '../modules/store/order-emails.ts';
import { sendOrderUpdate, sendPlacedSms } from '../modules/store/order-updates.ts';
import { checkInBackground } from '../modules/admin/orders/courier-record.ts';
import { checkTry } from '../modules/payments/service.ts';
import { sendBatch, startCampaign } from '../modules/push/campaigns.ts';
import { runWishlistAlerts } from '../modules/push/wishlist-alerts.ts';
import { cleanUpActivity } from '../modules/store/activity.ts';
import type { OrderUpdate } from '../modules/store/order-updates.ts';
import { QUEUES, startBoss } from './boss.ts';

/** Starts the background workers. Runs inside the API (demo) or as its own process (production). */
export async function startWorkers() {
  const boss = await startBoss();
  await boss.work<{ jobId: number }>(QUEUES.productImport, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await runImport(job.data.jobId, job.signal);
  });
  await boss.work<{ runId: number }>(QUEUES.oldSiteRead, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await readOldSite(job.data.runId);
  });
  await boss.work<{ orderId: number }>(QUEUES.orderPlaced, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    await sendOrderEmails(job.data.orderId);
    await sendPlacedSms(job.data.orderId);
  });
  await boss.work<{ orderId: number; status: OrderUpdate }>(QUEUES.orderStatus, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (job) await sendOrderUpdate(job.data.orderId, job.data.status);
  });
  await boss.work<{ phone: string }>(QUEUES.courierCheck, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (job) await checkInBackground(job.data.phone);
  });
  await boss.work<{ tranId: string }>(QUEUES.paymentCheck, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (job) await checkTry(job.data.tranId);
  });
  await boss.work<{ campaignId: number }>(QUEUES.pushCampaign, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (job) await startCampaign(job.data.campaignId);
  });
  // Several batches at once per worker process (each sends 20 at a time); more processes share the work.
  await boss.work<{ campaignId: number; ids: number[] }>(QUEUES.pushBatch, { batchSize: 1, pollingIntervalSeconds: 2, localConcurrency: 4 }, async ([job]) => {
    if (job) await sendBatch(job.data.campaignId, job.data.ids);
  });
  await boss.work(QUEUES.wishlistAlerts, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await runWishlistAlerts();
  });
  await boss.schedule(QUEUES.wishlistAlerts, '0 11 * * *', {}, { tz: 'Asia/Dhaka' });
  await boss.work(QUEUES.activityCleanup, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await cleanUpActivity();
  });
  await boss.schedule(QUEUES.activityCleanup, '0 3 * * *', {}, { tz: 'Asia/Dhaka' });
  logger.info('Background workers started');
}
