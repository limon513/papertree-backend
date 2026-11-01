import { z } from 'zod';
import { ADMIN_MODULE_KEYS } from '../modules.ts';

const roleName = z
  .string({ error: 'Role name is required' })
  .trim()
  .min(2, { error: 'Role name must be at least 2 characters' })
  .max(60, { error: 'Role name is too long' });

const description = z.string().trim().max(300, { error: 'Description is too long' }).nullable();

const modules = z
  .array(z.enum(ADMIN_MODULE_KEYS, { error: 'Unknown section' }))
  .transform((list) => [...new Set(list)])
  .meta({ description: 'Admin sections this role can open' });

export const createRoleBody = z
  .object({
    name: roleName,
    description: description.optional(),
    modules: modules.default([]),
    canImpersonate: z.boolean().default(false).meta({ description: 'Can use "Login as customer"' }),
  })
  .meta({ id: 'CreateRoleBody' });

export const updateRoleBody = z
  .object({
    name: roleName.optional(),
    description: description.optional(),
    modules: modules.optional(),
    canImpersonate: z.boolean().optional(),
  })
  .meta({ id: 'UpdateRoleBody' });

// ---- Responses (used for docs) ----

export const role = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string().nullable(),
    modules: z.array(z.enum(ADMIN_MODULE_KEYS)),
    canImpersonate: z.boolean(),
    isSuperAdmin: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Role' });

export const roleList = z
  .object({ items: z.array(role.extend({ staffCount: z.number() })) })
  .meta({ id: 'RoleList' });
