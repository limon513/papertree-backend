import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { labelBody, labelList, labelSchema } from './schemas.ts';

const tags = ['Admin: Tags'];
const security = adminAuth;
const access = 'Needs the Products section.';

export const labelsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/labels': {
    get: {
      tags,
      security,
      summary: 'List tags',
      description: `${access} Tags are shown on the website as coloured badges ("Overseas"), with a filter on product lists. Ordered by sortOrder, then name.`,
      responses: { '200': json(labelList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a tag',
      description: `${access} Names are unique (not case-sensitive).`,
      requestBody: jsonBody(labelBody),
      responses: { '201': json(labelSchema, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/labels/{id}': {
    put: {
      tags,
      security,
      summary: 'Change a tag',
      description: `${access} Without a slug the old one is kept, so shared filter links keep working.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(labelBody),
      responses: { '200': json(labelSchema), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a tag',
      description: `${access} It comes off every product that has it.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(401, 403, 404) },
    },
  },
};
