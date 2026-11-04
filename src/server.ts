import { env } from './config/env.ts';
import { pool } from './db/client.ts';
import { boss } from './jobs/boss.ts';
import { startWorkers } from './jobs/workers.ts';
import { logger } from './lib/logger.ts';
import { createApp } from './app.ts';

const server = createApp().listen(env.PORT, () => {
  logger.info(`API running on http://localhost:${env.PORT}`);
});

// Background jobs (imports) run in this process unless JOB_WORKERS=false
// (in production they run as separate PM2 processes: src/worker.ts).
if (env.JOB_WORKERS) {
  startWorkers().catch((err) => logger.error({ err }, 'Could not start background workers'));
}

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    // Let a running job finish its current step; it continues after the restart.
    await boss.stop({ graceful: true, timeout: 8_000 }).catch(() => {});
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
