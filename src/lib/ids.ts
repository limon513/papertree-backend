import { z } from 'zod';
import { notFound } from './errors.ts';

const idSchema = z.coerce.number().int().positive();

/** Reads a numeric id from a route param, or answers 404 if it is not a valid id. */
export function parseId(value: unknown): number {
  const result = idSchema.safeParse(value);
  if (!result.success) throw notFound();
  return result.data;
}
