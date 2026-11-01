import { z } from 'zod';
import type { ZodOpenApiResponsesObject } from 'zod-openapi';

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_ERROR' }),
      message: z.string().meta({ example: 'Please check the highlighted fields' }),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .meta({ description: 'Error message per form field', example: { email: 'Enter a valid email address' } }),
    }),
  })
  .meta({ id: 'Error' });

const ERROR_TEXT = {
  400: 'Invalid input',
  401: 'Not signed in',
  403: 'No access',
  404: 'Not found',
  409: 'Already exists',
  429: 'Too many requests',
} as const;

type ErrorStatus = keyof typeof ERROR_TEXT;

/** Standard error responses for an endpoint. */
export function errors(...statuses: ErrorStatus[]): ZodOpenApiResponsesObject {
  return Object.fromEntries(
    statuses.map((s) => [
      String(s),
      { description: ERROR_TEXT[s], content: { 'application/json': { schema: errorSchema } } },
    ]),
  );
}

/** A JSON response body. */
export const json = (schema: z.ZodType, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

/** A JSON request body. */
export const jsonBody = (schema: z.ZodType) => ({
  content: { 'application/json': { schema } },
});

export const idParam = z.object({ id: z.string().meta({ description: 'Numeric id', example: '1' }) });

export const noContent = { description: 'Done (no content)' };

/** Endpoints that need the admin session cookie. */
export const adminAuth = [{ adminCookie: [] }];
