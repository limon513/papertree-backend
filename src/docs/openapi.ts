import { createDocument } from 'zod-openapi';
import { authDocs } from '../modules/admin/auth/docs.ts';
import { brandsDocs } from '../modules/admin/brands/docs.ts';
import { categoriesDocs } from '../modules/admin/categories/docs.ts';
import { importsDocs } from '../modules/admin/imports/docs.ts';
import { mediaDocs } from '../modules/admin/media/docs.ts';
import { customersDocs } from '../modules/admin/customers/docs.ts';
import { storeDocs } from '../modules/store/docs.ts';
import { ordersDocs } from '../modules/admin/orders/docs.ts';
import { productsDocs } from '../modules/admin/products/docs.ts';
import { rolesDocs } from '../modules/admin/roles/docs.ts';
import { settingsDocs } from '../modules/admin/settings/docs.ts';
import { staffDocs } from '../modules/admin/staff/docs.ts';
import { searchDocs } from '../modules/admin/search/docs.ts';
import { requestsDocs } from '../modules/admin/requests/docs.ts';
import { contentDocs } from '../modules/admin/content/docs.ts';
import { integrationsDocs } from '../modules/admin/integrations/docs.ts';

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
      ...categoriesDocs,
      ...brandsDocs,
      ...mediaDocs,
      ...productsDocs,
      ...importsDocs,
      ...settingsDocs,
      ...ordersDocs,
      ...customersDocs,
      ...searchDocs,
      ...requestsDocs,
      ...contentDocs,
      ...integrationsDocs,
      ...storeDocs,
    },
  });
}
