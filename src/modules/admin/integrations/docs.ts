import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, json, jsonBody } from '../../../docs/common.ts';
import { integrationBody, integrationKeyParam, integrationView, messageListQuery, testBody } from './schemas.ts';

const tags = ['Admin: Integrations'];
const security = adminAuth;
const access =
  'Super Admins only. Services: email (Resend), sms (BulkSMSBD; test mode writes to the message log), google (Firebase web settings for Google sign-in) ' +
  'and payment (SSLCommerz, not switched on yet). Secrets (API keys, passwords) are encrypted with the server SECRETS_KEY and never returned: ' +
  'only a hint like "re_…a3f9". 503 SECRETS_KEY_MISSING when the server has no SECRETS_KEY.';

const message = z.object({}).catchall(z.unknown()).meta({ id: 'MessageLogEntry' });

export const integrationsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/integrations': {
    get: {
      tags,
      security,
      summary: 'All services and their state',
      description: `${access} state: ready, test (SMS test mode), off, or incomplete (switched on but something is missing).`,
      responses: { '200': json(z.object({ canKeepSecrets: z.boolean(), items: z.array(integrationView) })), ...errors(401, 403) },
    },
  },
  '/v1/admin/integrations/{key}': {
    put: {
      tags,
      security,
      summary: 'Save a service',
      description: `${access} settings in full. secrets: a value replaces the saved one, null removes it, a missing field keeps it. The audit log records which fields changed, never their values.`,
      requestParams: { path: integrationKeyParam },
      requestBody: jsonBody(integrationBody),
      responses: { '200': json(integrationView), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/integrations/{key}/test': {
    post: {
      tags,
      security,
      summary: 'Send a test (email or sms)',
      description: `${access} Sends a test to the given address or phone and returns the message log entry (status sent, failed with the reason, or logged).`,
      requestParams: { path: integrationKeyParam },
      requestBody: jsonBody(testBody),
      responses: { '200': json(message), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/integrations/messages': {
    get: {
      tags,
      security,
      summary: 'Sent messages',
      description: `${access} Every email and SMS the shop sent or, in test mode, would have sent. 50 per page, newest first.`,
      requestParams: { query: messageListQuery },
      responses: { '200': json(z.object({ items: z.array(message), total: z.number(), page: z.number(), pageSize: z.number() })), ...errors(401, 403) },
    },
  },
};
