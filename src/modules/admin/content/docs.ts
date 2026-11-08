import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { bannerBody, bannerOrderBody, bannerView } from './schemas.ts';

const tags = ['Admin: Website content'];
const security = adminAuth;
const access =
  'Needs the Website Content section. Banners on the home page: "hero" is the top slider (pictures 2:1, e.g. 1200 × 600), ' +
  '"tile" a smaller offer beside it (2:1, e.g. 600 × 300; the first two are shown). Shown while active and between startsAt and endsAt. ' +
  'The website shows changes within about a minute. GIFs keep moving.';

export const contentDocs: ZodOpenApiPathsObject = {
  '/v1/admin/banners': {
    get: {
      tags,
      security,
      summary: 'List banners',
      description: `${access} Both places, in order, each with its state now.`,
      responses: { '200': json(z.array(bannerView)), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a banner',
      description: `${access} Upload the pictures first (POST /v1/admin/media). It goes last in its place.`,
      requestBody: jsonBody(bannerBody),
      responses: { '201': json(bannerView, 'Added'), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/banners/order': {
    put: {
      tags,
      security,
      summary: 'Change the order',
      description: `${access} The ids of one place, first shown first. Returns all banners.`,
      requestBody: jsonBody(bannerOrderBody),
      responses: { '200': json(z.array(bannerView)), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/banners/{id}': {
    put: {
      tags,
      security,
      summary: 'Change a banner',
      description: access,
      requestParams: { path: idParam },
      requestBody: jsonBody(bannerBody),
      responses: { '200': json(bannerView), ...errors(400, 401, 403, 404) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a banner',
      description: `${access} The pictures stay in the media library.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(401, 403, 404) },
    },
  },
};
