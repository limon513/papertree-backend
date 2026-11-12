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
  /** Data: { orderId }. Emails after a website order (customer confirmation, shop alert). */
  orderPlaced: 'order-placed',
  /** Data: { runId } of an old_site_runs row. Reads the old website for "Move from old site". */
  oldSiteRead: 'old-site-read',
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
    // Reading a big old site can take a while; not retried (start it again from the page instead).
    await boss.createQueue(QUEUES.oldSiteRead, { expireInSeconds: 3 * 3600, retryLimit: 0 });
    return boss;
  })();
  return started;
}

export async function sendJob(queue: string, data: object) {
  await startBoss();
  return boss.send(queue, data);
}
