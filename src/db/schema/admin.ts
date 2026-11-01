import { boolean, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

/**
 * A role is a named set of admin sections (modules) a staff member can open.
 * The Super Admin role has access to everything, including staff and roles.
 */
export const roles = pgTable('roles', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  modules: text('modules').array().notNull().default([]),
  canImpersonate: boolean('can_impersonate').notNull().default(false),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  ...timestamps,
});

export type AdminUserStatus = 'active' | 'disabled';

export const adminUsers = pgTable('admin_users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  roleId: ref('role_id')
    .notNull()
    .references(() => roles.id, { onDelete: 'restrict' }),
  status: text('status').$type<AdminUserStatus>().notNull().default('active'),
  lastLoginAt: timestamptz('last_login_at'),
  ...timestamps,
});

/** The session id is the SHA-256 hash of the cookie token. */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    adminUserId: ref('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamptz('expires_at').notNull(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('admin_sessions_admin_user_id_idx').on(t.adminUserId)],
);

/** Every change made from the admin panel is recorded here. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    adminUserId: ref('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_admin_user_id_idx').on(t.adminUserId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);
