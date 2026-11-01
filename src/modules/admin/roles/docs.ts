import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { createRoleBody, role, roleList, updateRoleBody } from './schemas.ts';

const tags = ['Admin: Roles'];
const security = adminAuth;
const superAdminOnly = 'Super Admin only.';

export const rolesDocs: ZodOpenApiPathsObject = {
  '/v1/admin/roles': {
    get: {
      tags,
      security,
      summary: 'List roles',
      description: `${superAdminOnly} Includes how many staff have each role.`,
      responses: { '200': json(roleList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Create a role',
      description: superAdminOnly,
      requestBody: jsonBody(createRoleBody),
      responses: { '201': json(role, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/roles/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a role',
      requestParams: { path: idParam },
      responses: { '200': json(role), ...errors(401, 403, 404) },
    },
    patch: {
      tags,
      security,
      summary: 'Update a role',
      description: `${superAdminOnly} The Super Admin role can only be renamed, never limited.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateRoleBody),
      responses: { '200': json(role), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a role',
      description: `${superAdminOnly} Not allowed for the Super Admin role or while staff still have the role.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
};
