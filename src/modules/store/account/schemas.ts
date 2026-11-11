import { z } from 'zod';
import { bdPhone } from '../../../lib/phone.ts';
import { nameSchema } from '../../admin/schemas.ts';

export const codeBody = z.object({ phone: bdPhone }).meta({ id: 'StoreSignInCodeBody' });

export const verifyBody = z
  .object({
    phone: bdPhone,
    code: z.string().trim().regex(/^\d{6}$/, { error: 'Enter the 6-digit code' }).meta({ example: '123456' }),
    /** Only for a new number. */
    name: nameSchema.optional().meta({ description: 'Needed for a new number only' }),
    /** From a first Google sign-in: links that Google account to this number. */
    googleTicket: z.string().max(4000).optional().meta({ description: 'The ticket from /auth/google, to link that Google account to this number' }),
  })
  .meta({ id: 'StoreSignInVerifyBody' });

export const googleBody = z
  .object({ idToken: z.string().min(20).max(4000).meta({ description: 'The Firebase ID token from signing in with Google' }) })
  .meta({ id: 'StoreGoogleSignInBody' });
