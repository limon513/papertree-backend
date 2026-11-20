import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody } from '../../../docs/common.ts';
import { customRequestBody } from '../../store/custom-requests.ts';
import { customRequestListQuery, customRequestUpdate } from './custom.ts';

const tags = ['Admin: Requests'];
const access = 'Needs the Requests & Leads section.';

/** Custom orders: the website's Custom Order Studio, and the admin list. */
export const customRequestsDocs: ZodOpenApiPathsObject = {
  '/v1/store/custom-requests': {
    post: {
      tags: ['Store'],
      summary: 'Send a custom order request',
      description:
        'What to make (kind), the answers (specs), quantity, notes and contact. fileIds: files uploaded first by the same signed-in shopper, not sent before (at most 3). ' +
        'Staff get an email at the staff address. 8 per visitor per hour. "website" must stay empty.',
      requestBody: jsonBody(customRequestBody),
      responses: { '201': json(z.object({ number: z.string().nullable() }), 'Sent'), ...errors(400, 401, 429) },
    },
  },
  '/v1/store/custom-requests/files': {
    post: {
      tags: ['Store'],
      summary: 'Upload artwork for a custom request (signed in)',
      description: 'multipart/form-data, field "file": a JPG, PNG, WebP picture or a PDF (checked by its content), up to 5 MB. Kept under a long random name; staff see it with the request.',
      responses: { '201': json(z.object({ id: z.number(), fileName: z.string(), size: z.number(), contentType: z.string() }), 'Uploaded'), ...errors(400, 401, 429) },
    },
  },
  '/v1/store/custom-requests/files/{id}': {
    delete: {
      tags: ['Store'],
      summary: 'Remove an uploaded file not sent yet (signed in)',
      requestParams: { path: idParam },
      responses: { '204': { description: 'Removed' }, ...errors(401, 404) },
    },
  },
  '/v1/admin/custom-requests': {
    get: {
      tags,
      security: adminAuth,
      summary: 'List custom order requests',
      description: `${access} 50 per page; new ones oldest first. Each with its files (links for staff) and the quotations made for it.`,
      requestParams: { query: customRequestListQuery },
      responses: { '200': { description: 'Requests' }, ...errors(401, 403) },
    },
  },
  '/v1/admin/custom-requests/{id}': {
    get: {
      tags,
      security: adminAuth,
      summary: 'A custom order request',
      requestParams: { path: idParam },
      responses: { '200': { description: 'The request' }, ...errors(401, 403, 404) },
    },
    put: {
      tags,
      security: adminAuth,
      summary: 'Set its status (new, quoted, closed) and a note',
      description: `${access} A quotation made for the request (customRequestId) marks it quoted by itself.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(customRequestUpdate),
      responses: { '200': { description: 'The request' }, ...errors(400, 401, 403, 404) },
    },
  },
};
