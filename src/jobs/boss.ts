import { PgBoss } from 'pg-boss';
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
} as const;

let started: Promise<PgBoss> | null = null;

/** Starts the queue (once). Needed before sending jobs. */
export function startBoss() {
  started ??= (async () => {
    await boss.start();
    // An import can take a while (images are downloaded); allow up to 3 hours.
    // After a crash it is retried and continues where it stopped.
    await boss.createQueue(QUEUES.productImport, { expireInSeconds: 3 * 3600, retryLimit: 2, retryDelay: 30 });
    return boss;
  })();
  return started;
}

export async function sendJob(queue: string, data: object) {
  await startBoss();
  return boss.send(queue, data);
}
