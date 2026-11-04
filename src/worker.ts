/**
 * Background workers only (no web server). In production PM2 runs this next to the API
 * processes, and the API runs with JOB_WORKERS=false.
 */
import { pool } from './db/client.ts';
import { boss } from './jobs/boss.ts';
import { startWorkers } from './jobs/workers.ts';
import { logger } from './lib/logger.ts';

await startWorkers();

async function shutdown(signal: string) {
  logger.info(`${signal} received, stopping workers`);
  setTimeout(() => process.exit(1), 30_000).unref();
  await boss.stop({ graceful: true, timeout: 25_000 }).catch(() => {});
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
