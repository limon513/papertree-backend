import { z } from 'zod';
import { ADMIN_MODULES } from '../modules.ts';
import { emailSchema, passwordSchema } from '../schemas.ts';

export const loginBody = z
  .object({
    email: emailSchema.meta({ example: 'admin@papertree.com.bd' }),
    password: z.string({ error: 'Password is required' }).min(1, { error: 'Password is required' }),
  })
  .meta({ id: 'LoginBody' });

export const changePasswordBody = z
  .object({
    currentPassword: z
      .string({ error: 'Current password is required' })
      .min(1, { error: 'Current password is required' }),
    newPassword: passwordSchema,
  })
  .meta({ id: 'ChangePasswordBody' });

// ---- Responses (used for docs) ----

const adminModule = z.object({
  key: z.enum(ADMIN_MODULES.map((m) => m.key) as [string, ...string[]]),
  label: z.string(),
  description: z.string(),
});

export const signedInAdmin = z
  .object({
    admin: z.object({
      id: z.number(),
      name: z.string(),
      email: z.string(),
      role: z.object({
        id: z.number(),
        name: z.string(),
        modules: z.array(z.string()),
        canImpersonate: z.boolean(),
        isSuperAdmin: z.boolean(),
      }),
    }),
    modules: z.array(adminModule).meta({ description: 'All admin sections, for building the menu' }),
  })
  .meta({ id: 'SignedInAdmin' });
