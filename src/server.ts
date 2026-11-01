import { env } from './config/env.ts';
import { pool } from './db/client.ts';
import { logger } from './lib/logger.ts';
import { createApp } from './app.ts';

const server = createApp().listen(env.PORT, () => {
  logger.info(`API running on http://localhost:${env.PORT}`);
});

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
