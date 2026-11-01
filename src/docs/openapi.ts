import { createDocument } from 'zod-openapi';
import { authDocs } from '../modules/admin/auth/docs.ts';
import { rolesDocs } from '../modules/admin/roles/docs.ts';
import { staffDocs } from '../modules/admin/staff/docs.ts';

/** The OpenAPI document, built from the same zod schemas the routes use to validate requests. */
export function buildOpenApiDocument() {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'PaperTree API',
      version: '0.1.0',
      description: 'Admin and storefront API for PaperTree Bangladesh. Sign in first: the session is kept in a cookie.',
    },
    servers: [{ url: '/', description: 'This server' }],
    components: {
      securitySchemes: {
        adminCookie: { type: 'apiKey', in: 'cookie', name: 'pt_admin', description: 'Set by POST /v1/admin/auth/login' },
      },
    },
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: { '200': { description: 'API and database are up' }, '503': { description: 'Database is down' } },
        },
      },
      ...authDocs,
      ...staffDocs,
      ...rolesDocs,
    },
  });
}
