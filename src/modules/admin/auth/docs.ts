import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, json, jsonBody, noContent } from '../../../docs/common.ts';
import { changePasswordBody, loginBody, signedInAdmin } from './schemas.ts';

const tags = ['Admin: Auth'];

export const authDocs: ZodOpenApiPathsObject = {
  '/v1/admin/auth/login': {
    post: {
      tags,
      summary: 'Sign in',
      description: 'Sets the `pt_admin` session cookie. 10 failed attempts lock the IP out for 15 minutes.',
      requestBody: jsonBody(loginBody),
      responses: { '200': json(signedInAdmin), ...errors(400, 401, 403, 429) },
    },
  },
  '/v1/admin/auth/logout': {
    post: {
      tags,
      summary: 'Sign out',
      responses: { '204': noContent },
    },
  },
  '/v1/admin/auth/me': {
    get: {
      tags,
      summary: 'Who is signed in',
      security: adminAuth,
      responses: { '200': json(signedInAdmin), ...errors(401) },
    },
  },
  '/v1/admin/auth/change-password': {
    post: {
      tags,
      summary: 'Change my password',
      description: 'Signs you out on every other browser.',
      security: adminAuth,
      requestBody: jsonBody(changePasswordBody),
      responses: { '204': noContent, ...errors(400, 401) },
    },
  },
};
