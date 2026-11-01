import { logger } from '../lib/logger.ts';
import { runImport } from '../modules/admin/imports/run.ts';
import { QUEUES, startBoss } from './boss.ts';

/** Starts the background workers. Runs inside the API (demo) or as its own process (production). */
export async function startWorkers() {
  const boss = await startBoss();
  await boss.work<{ jobId: number }>(QUEUES.productImport, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await runImport(job.data.jobId, job.signal);
  });
  logger.info('Background workers started');
}
