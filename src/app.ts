import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'drizzle-orm';
import { apiReference } from '@scalar/express-api-reference';
import { buildOpenApiDocument } from './docs/openapi.ts';
import { env } from './config/env.ts';
import { db } from './db/client.ts';
import { logger } from './lib/logger.ts';
import { LOCAL_UPLOADS_DIR } from './lib/storage.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { adminRouter } from './modules/admin/router.ts';

const ICONS_DIR = join(import.meta.dirname, '..', 'public', 'icons');

export function createApp() {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);

  // API docs are registered before helmet: the docs page loads its UI from a CDN,
  // which the strict security headers on the rest of the API would block.
  if (env.API_DOCS) {
    const document = buildOpenApiDocument();
    app.get('/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.get('/docs', apiReference({ url: '/openapi.json', pageTitle: 'PaperTree API' }));
  }

  app.use(helmet());

  // Icon files, and uploaded images when they are kept on this server instead of S3.
  // Shown as <img> on the admin panel and website (other addresses), so allow cross-origin use.
  const crossOrigin = (res: express.Response) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  app.use('/icons', express.static(ICONS_DIR, { maxAge: '30d', setHeaders: crossOrigin }));
  if (env.STORAGE_DRIVER === 'local') {
    app.use(
      '/uploads',
      express.static(LOCAL_UPLOADS_DIR, { maxAge: '365d', immutable: true, setHeaders: crossOrigin }),
    );
  }

  app.use(cors({ origin: [env.ADMIN_APP_URL], credentials: true }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });

  app.use('/v1/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
