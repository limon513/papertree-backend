import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { id, ref, timestamptz } from './_helpers.ts';

export const INTEGRATION_KEYS = ['email', 'sms', 'google', 'payment'] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/**
 * Outside services, set up in the admin (Super Admins): email (Resend), SMS (BulkSMSBD), Google
 * sign-in (Firebase) and online payment (SSLCommerz). `settings` holds what is not secret;
 * `secrets` holds API keys and passwords, encrypted with the server's SECRETS_KEY (AES-256-GCM),
 * so the database alone (or a backup) never reveals them.
 */
export const integrations = pgTable('integrations', {
  key: text('key').$type<IntegrationKey>().primaryKey(),
  settings: jsonb('settings').notNull().default({}),
  /** Encrypted JSON of the secret fields: "v1.<iv>.<tag>.<data>" (base64url). */
  secrets: text('secrets'),
  updatedBy: ref('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export type MessageChannel = 'email' | 'sms';
/** sent: the service took it; failed: it did not; logged: test mode, only written here. */
export type MessageStatus = 'sent' | 'failed' | 'logged';

/** Every email and SMS the shop sends (or, in test mode, would send). */
export const messageLog = pgTable(
  'message_log',
  {
    id: id(),
    channel: text('channel').$type<MessageChannel>().notNull(),
    /** Email address or phone number. */
    to: text('to').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    status: text('status').$type<MessageStatus>().notNull(),
    provider: text('provider').notNull(),
    error: text('error'),
    /** What it was for: "order.placed", "test", "login.code". */
    purpose: text('purpose').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('message_log_created_at_idx').on(t.createdAt), index('message_log_channel_idx').on(t.channel, t.createdAt)],
);
