import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, json } from '../../../docs/common.ts';
import { iconList, MAX_UPLOAD_MB, mediaSchema, uploadBody } from './schemas.ts';

const security = adminAuth;

export const mediaDocs: ZodOpenApiPathsObject = {
  '/v1/admin/media': {
    post: {
      tags: ['Admin: Media'],
      security,
      summary: 'Upload an image',
      description:
        `Multipart form with one \`file\` (up to ${MAX_UPLOAD_MB} MB). ` +
        'Saved as WebP in widths 160, 400, 800 and 1600 (never larger than the original). ' +
        'Use the returned id as `imageId` on a category or brand.',
      requestBody: { content: { 'multipart/form-data': { schema: uploadBody } } },
      responses: { '201': json(mediaSchema, 'Uploaded'), ...errors(400, 401) },
    },
  },
  '/v1/admin/icons': {
    get: {
      tags: ['Admin: Media'],
      security,
      summary: 'List icons',
      description: 'Icons that categories and brands can use. Each file is at /icons/{key}.svg.',
      responses: { '200': json(iconList), ...errors(401) },
    },
  },
};
