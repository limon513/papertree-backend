import { z } from 'zod';
import { emailSchema, nameSchema, passwordSchema } from '../schemas.ts';

const statusSchema = z.enum(['active', 'disabled'], { error: 'Status must be active or disabled' });
const roleIdSchema = z.coerce.number({ error: 'Choose a role' }).int().positive({ error: 'Choose a role' });

export const createStaffBody = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    roleId: roleIdSchema,
    status: statusSchema.default('active'),
  })
  .meta({ id: 'CreateStaffBody' });

export const updateStaffBody = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema.optional().meta({ description: 'Set a new password (signs them out everywhere)' }),
    roleId: roleIdSchema.optional(),
    status: statusSchema.optional(),
  })
  .meta({ id: 'UpdateStaffBody' });

// ---- Responses (used for docs) ----

export const staff = z
  .object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    status: z.enum(['active', 'disabled']),
    lastLoginAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    role: z.object({ id: z.number(), name: z.string(), isSuperAdmin: z.boolean() }),
  })
  .meta({ id: 'Staff' });

export const staffList = z.object({ items: z.array(staff) }).meta({ id: 'StaffList' });
