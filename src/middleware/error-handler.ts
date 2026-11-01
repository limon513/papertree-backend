import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { MAX_UPLOAD_MB } from '../modules/admin/media/schemas.ts';

interface ErrorBody {
  error: { code: string; message: string; fields?: Record<string, string>; details?: unknown };
}

/** Turns zod issues into { "field.path": "first message" } for showing under form fields. */
function fieldErrors(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Postgres error code, also when wrapped by drizzle. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const send = (status: number, body: ErrorBody) => res.status(status).json(body);

  if (err instanceof ZodError) {
    return send(400, {
      error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', fields: fieldErrors(err) },
    });
  }

  if (err instanceof AppError) {
    const details = err.details;
    const isFieldMap = details && typeof details === 'object' && !Array.isArray(details);
    return send(err.status, {
      error: {
        code: err.code,
        message: err.message,
        ...(isFieldMap ? { fields: details as Record<string, string> } : details ? { details } : {}),
      },
    });
  }

  // File upload errors.
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const message = `The file is too big. The limit is ${MAX_UPLOAD_MB} MB.`;
      return send(413, { error: { code: 'TOO_LARGE', message, fields: { file: message } } });
    }
    return send(400, { error: { code: 'BAD_UPLOAD', message: 'Upload one image at a time, in the "file" field' } });
  }

  // Body parser errors (bad JSON, body too large).
  const parserError = err as { type?: string; status?: number };
  if (parserError?.type === 'entity.parse.failed') {
    return send(400, { error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON' } });
  }
  if (parserError?.type === 'entity.too.large') {
    return send(413, { error: { code: 'TOO_LARGE', message: 'The request is too large' } });
  }

  if (pgCode(err) === '23505') {
    return send(409, { error: { code: 'CONFLICT', message: 'This value is already in use' } });
  }

  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  return send(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This API route does not exist' } });
}
