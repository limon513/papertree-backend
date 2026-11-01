import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json } from '../../../docs/common.ts';
import { importDetail, importJobSchema, importList, importOptionsBody, importRowsQuery, MAX_CSV_MB } from './schemas.ts';

const tags = ['Admin: Imports'];
const security = adminAuth;
const access = 'Needs the Product Imports section.';

const uploadBody = importOptionsBody
  .extend({ file: z.string().meta({ format: 'binary', description: `CSV file, up to ${MAX_CSV_MB} MB` }) })
  .meta({ id: 'ImportUploadBody' });

export const importsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/imports': {
    get: {
      tags,
      security,
      summary: 'List imports',
      description: `${access} The latest 30 imports.`,
      responses: { '200': json(importList), ...errors(401, 403) },
    },
  },
  '/v1/admin/imports/template.csv': {
    get: {
      tags,
      security,
      summary: 'Download the CSV template',
      description: `${access} One line per variant. Lines with the same name are one product.`,
      responses: { '200': { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }, ...errors(401, 403) },
    },
  },
  '/v1/admin/imports/products': {
    post: {
      tags,
      security,
      summary: 'Upload and check a product file',
      description:
        `${access} Accepts the PaperTree template or a WooCommerce product export. ` +
        'Every product is checked and marked create, update, skip or error. Nothing is imported until you start it.',
      requestBody: { content: { 'multipart/form-data': { schema: uploadBody } } },
      responses: { '201': json(importJobSchema, 'Checked'), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/imports/{id}': {
    get: {
      tags,
      security,
      summary: 'Get an import with its products',
      description: `${access} Products are listed 100 per page, optionally filtered.`,
      requestParams: { path: idParam, query: importRowsQuery },
      responses: { '200': json(importDetail), ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/imports/{id}/start': {
    post: {
      tags,
      security,
      summary: 'Start an import',
      description: `${access} Runs in the background. Follow the progress with GET /v1/admin/imports/{id}.`,
      requestParams: { path: idParam },
      responses: { '200': json(importJobSchema), ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/imports/{id}/cancel': {
    post: {
      tags,
      security,
      summary: 'Cancel an import',
      description: `${access} Products already imported stay.`,
      requestParams: { path: idParam },
      responses: { '200': json(importJobSchema), ...errors(400, 401, 403, 404) },
    },
  },
};
