import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errors, json, jsonBody } from '../../../docs/common.ts';
import { codeBody, googleBody, verifyBody } from './schemas.ts';

const tags = ['Store: sign-in and account'];
const open = z.object({}).catchall(z.unknown());
const signedIn = 'Needs the shopper\'s sign-in cookie (pt_customer), set by /auth/verify or /auth/google.';

export const accountDocs: ZodOpenApiPathsObject = {
  '/v1/store/auth/code': {
    post: {
      tags,
      summary: 'Send a sign-in code by SMS',
      description:
        'A 6-digit code, valid 5 minutes, 5 tries. A new code replaces the old one. One code a minute and 5 an hour per number. ' +
        'Until SMS is connected the code is only in the message log; on a developer\'s computer the answer also has devCode.',
      requestBody: jsonBody(codeBody),
      responses: { '200': json(open.meta({ id: 'StoreSignInCodeSent' })), ...errors(400, 429) },
    },
  },
  '/v1/store/auth/verify': {
    post: {
      tags,
      summary: 'Sign in with the code',
      description:
        'Right code: signs in (sets the cookie) and returns { customer }. A new number without a name returns { needsName: true } and the code stays valid: send it again with name. ' +
        'With googleTicket, that Google account is linked, so next time Google signs in directly. Blocked customers get 403.',
      requestBody: jsonBody(verifyBody),
      responses: { '200': json(open.meta({ id: 'StoreSignedIn' })), ...errors(400, 403, 409, 429) },
    },
  },
  '/v1/store/auth/google': {
    post: {
      tags,
      summary: 'Sign in with Google',
      description:
        'The Firebase ID token is checked with Google\'s public keys. A known Google account signs in: { customer }. A new one returns { needsPhone: true, ticket, name, avatarUrl }: ' +
        'confirm a phone with /auth/code and /auth/verify (with googleTicket). Accounts are never matched by email alone.',
      requestBody: jsonBody(googleBody),
      responses: { '200': json(open.meta({ id: 'StoreGoogleSignIn' })), ...errors(400, 403) },
    },
  },
  '/v1/store/auth/logout': {
    post: { tags, summary: 'Sign out', responses: { '200': json(z.object({ ok: z.boolean() })) } },
  },
  '/v1/store/me': {
    get: {
      tags,
      summary: 'Who is signed in',
      description: '{ customer } with name, phone, email, Google photo address, and the address to fill in at checkout; { customer: null } when signed out.',
      responses: { '200': json(open.meta({ id: 'StoreMe' })) },
    },
  },
  '/v1/store/me/orders': {
    get: {
      tags,
      summary: 'My orders',
      description: `${signedIn} Newest first, 20 a page (?page=2), with the first item names and pictures.`,
      responses: { '200': json(open.meta({ id: 'StoreMyOrders' })), ...errors(401) },
    },
  },
  '/v1/store/me/orders/{number}': {
    get: {
      tags,
      summary: 'One of my orders',
      description: signedIn,
      requestParams: { path: z.object({ number: z.coerce.number().int() }) },
      responses: { '200': json(open.meta({ id: 'StoreMyOrder' })), ...errors(401, 404) },
    },
  },
};
