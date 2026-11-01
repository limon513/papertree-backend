import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { brand, brandList, createBrandBody, updateBrandBody } from './schemas.ts';

const tags = ['Admin: Brands'];
const security = adminAuth;
const access = 'Needs the Products section.';

export const brandsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/brands': {
    get: {
      tags,
      security,
      summary: 'List brands',
      description: access,
      responses: { '200': json(brandList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Create a brand',
      description: `${access} Brand names are unique (not case-sensitive).`,
      requestBody: jsonBody(createBrandBody),
      responses: { '201': json(brand, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/brands/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a brand',
      requestParams: { path: idParam },
      responses: { '200': json(brand), ...errors(401, 403, 404) },
    },
    patch: {
      tags,
      security,
      summary: 'Update a brand',
      description: `${access} An empty slug makes a new one from the name.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateBrandBody),
      responses: { '200': json(brand), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a brand',
      description: access,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(401, 403, 404) },
    },
  },
};
