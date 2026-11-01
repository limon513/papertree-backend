import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { createStaffBody, staff, staffList, updateStaffBody } from './schemas.ts';

const tags = ['Admin: Staff'];
const security = adminAuth;
const superAdminOnly = 'Super Admin only.';

export const staffDocs: ZodOpenApiPathsObject = {
  '/v1/admin/staff': {
    get: {
      tags,
      security,
      summary: 'List staff',
      description: superAdminOnly,
      responses: { '200': json(staffList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a staff member',
      description: superAdminOnly,
      requestBody: jsonBody(createStaffBody),
      responses: { '201': json(staff, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/staff/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a staff member',
      requestParams: { path: idParam },
      responses: { '200': json(staff), ...errors(401, 403, 404) },
    },
    patch: {
      tags,
      security,
      summary: 'Update a staff member',
      description: `${superAdminOnly} Disabling someone or resetting their password signs them out everywhere.
You cannot disable yourself or change your own role, and there is always at least one active Super Admin.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateStaffBody),
      responses: { '200': json(staff), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a staff member',
      description: `${superAdminOnly} You cannot delete yourself or the last active Super Admin.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
};
