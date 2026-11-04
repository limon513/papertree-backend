import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json } from '../../../docs/common.ts';
import {
  importDetail,
  importJobSchema,
  importList,
  importOptionsBody,
  importRowsQuery,
  linkCreateBody,
  linkCreateResponse,
  linkReadBody,
  linkReadResponse,
  MAX_CSV_MB,
} from './schemas.ts';

const tags = ['Admin: Imports'];
const security = adminAuth;
const access = 'Needs the Product Imports section.';

const uploadBody = importOptionsBody
  .extend({
    file: z.string().meta({
      format: 'binary',
      description: `CSV or Excel (.xlsx) file, up to ${MAX_CSV_MB} MB. Send two "file" parts for the Daraz "basic" and "price & stock" exports.`,
    }),
  })
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
        `${access} Accepts the PaperTree template, a WooCommerce product export, or Daraz Seller Center exports ` +
        '("basic" and/or "price & stock"; the Seller SKU becomes the SKU, brands are matched from the start of the name). ' +
        'Every product is checked and marked create, update, skip or error. Nothing is imported until you start it.',
      requestBody: { content: { 'multipart/form-data': { schema: uploadBody } } },
      responses: { '201': json(importJobSchema, 'Checked'), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/imports/link/read': {
    post: {
      tags,
      security,
      summary: 'Read a product page from another shop',
      description:
        `${access} Paste a product link (Daraz, a WooCommerce or Shopify shop, or most other shops). ` +
        'Returns the name, prices, pictures, description and variants found, and our brand and categories with the same names. ' +
        'Nothing is saved. Some sites (like AliExpress) share only the name and main picture.',
      requestBody: { content: { 'application/json': { schema: linkReadBody } } },
      responses: { '200': json(linkReadResponse), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/imports/link': {
    post: {
      tags,
      security,
      summary: 'Save a product from a link as a draft',
      description:
        `${access} Send what /link/read returned, after the user checked it. The chosen pictures are downloaded, ` +
        'the product is saved as a draft and the link is added to the import history.',
      requestBody: { content: { 'application/json': { schema: linkCreateBody } } },
      responses: { '201': json(linkCreateResponse, 'Draft created'), ...errors(400, 401, 403) },
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
