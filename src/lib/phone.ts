import { z } from 'zod';

/** "+880 1712-345678", "01712 345678" -> "01712345678". */
export const normalizePhone = (text: string) => text.replace(/[\s()-]/g, '').replace(/^\+?880/, '0');

export const isBdPhone = (phone: string) => /^0\d{9,10}$/.test(phone);

const PHONE_ERROR = 'Enter a Bangladeshi number, like 01712345678';

/** A required Bangladeshi phone number, cleaned. */
export const bdPhone = z
  .string({ error: 'Enter the phone number' })
  .trim()
  .min(1, { error: 'Enter the phone number' })
  .transform(normalizePhone)
  .refine(isBdPhone, { error: PHONE_ERROR })
  .meta({ example: '01712345678' });

/** An optional phone number: empty becomes null. */
export const optionalBdPhone = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? normalizePhone(v) : null))
  .refine((v) => v === null || isBdPhone(v), { error: PHONE_ERROR })
  .meta({ example: '01712345678' });
