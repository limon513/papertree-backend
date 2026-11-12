import { logger } from '../lib/logger.ts';
import { runImport } from '../modules/admin/imports/run.ts';
import { readOldSite } from '../modules/admin/migration/reader.ts';
import { sendOrderEmails } from '../modules/store/order-emails.ts';
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
    if (job) await sendOrderEmails(job.data.orderId);
  });
  logger.info('Background workers started');
}
