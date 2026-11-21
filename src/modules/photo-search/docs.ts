import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json } from '../../docs/common.ts';

const photoForm = (extra: Record<string, z.ZodType> = {}) => ({
  content: { 'multipart/form-data': { schema: z.object({ photo: z.string().meta({ format: 'binary', description: 'JPG, PNG, WebP, GIF or AVIF, up to 8 MB' }), ...extra }) } },
});

/** Search by photo (website) and its report (admin). */
export const photoSearchDocs: ZodOpenApiPathsObject = {
  '/v1/store/photo-search': {
    post: {
      tags: ['Store'],
      summary: 'Search with a photo',
      description:
        'The photo is looked at whole and closer up (where the item seems to be, else the middle), by an image model on this server. ' +
        'Returns product cards, closest first, each with score (0–1), match (same | close | similar) and main category; category counts for chips; ' +
        'and focus (where it looked closer, fractions) or null. crop = "x,y,w,h" (fractions) searches only that part. ' +
        'Photos with nothing close are kept 30 days for the search report (at most 300 a day). 40 searches per 10 minutes per visitor; 503 when switched off or busy.',
      requestBody: photoForm({ crop: z.string().optional().meta({ example: '0.1,0.2,0.6,0.5' }) }),
      responses: { '200': { description: '{ items, categories, focus }' }, '503': { description: 'Switched off, or busy (try again)' }, ...errors(400, 429) },
    },
  },
  '/v1/store/photo-search/similar/{productId}': {
    get: {
      tags: ['Store'],
      summary: 'Products that look like this one',
      description: 'From its main picture; the product itself is left out. Same shape as a photo search, plus product { id, name, slug }.',
      requestParams: { path: z.object({ productId: z.coerce.number() }) },
      responses: { '200': { description: '{ product, items, categories }' }, ...errors(404) },
    },
  },
  '/v1/store/photo-search/request': {
    post: {
      tags: ['Store'],
      summary: '"Ask us to find it" with the photo',
      description: 'A product request (Requests & Leads) with the photo attached. Same checks and limit as a product request (5 per hour).',
      requestBody: photoForm({ name: z.string(), phone: z.string(), details: z.string(), website: z.string().optional().meta({ description: 'Left empty (bots fill it)' }) }),
      responses: { '201': json(z.object({ ok: z.boolean() })), ...errors(400, 429) },
    },
  },
  '/v1/admin/search-report/photos': {
    get: {
      tags: ['Admin: Search'],
      security: adminAuth,
      summary: 'Search by photo report',
      description: 'Needs the Reports section. Photo searches, how many found the item, product pictures ready, and the photos with nothing close (last 60, kept 30 days).',
      requestParams: { query: z.object({ days: z.coerce.number().optional() }) },
      responses: { '200': { description: 'Report' }, ...errors(401, 403) },
    },
  },
  '/v1/admin/search-report/photos/{id}': {
    delete: {
      tags: ['Admin: Search'],
      security: adminAuth,
      summary: 'Remove a kept photo now',
      description: 'Deletes the photo at once (the search stays counted). In the audit log.',
      requestParams: { path: idParam },
      responses: { '204': { description: 'Removed' }, ...errors(401, 403, 404) },
    },
  },
};
