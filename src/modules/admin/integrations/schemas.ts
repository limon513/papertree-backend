import { z } from 'zod';
import { INTEGRATION_KEYS } from '../../../db/schema/index.ts';

const text = (max: number) => z.string().trim().max(max).default('');
const email = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === '' || z.email().safeParse(v).success, { error: 'Enter a valid email address' })
  .default('');

/**
 * What each service keeps. `settings` are shown back in the admin; `secrets` are encrypted and never
 * shown again (only "saved, ends in …a3f9").
 */
export const INTEGRATIONS = {
  email: {
    settings: z.object({
      /** off: no emails; resend: send with Resend. */
      provider: z.enum(['off', 'resend']).default('off'),
      fromName: text(100),
      fromEmail: email.meta({ description: 'An address on the domain verified in Resend, e.g. orders@papertree.com.bd' }),
      replyTo: email,
      /** Where "new order" alerts go. */
      staffEmail: email,
      /** Test mode: emails go only to the test addresses (the rest are only written to the log). Always on away from the live server. */
      testMode: z.boolean().default(true),
      testRecipients: z.array(z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address' }))).max(10, { error: 'At most 10' }).default([]),
    }),
    secrets: ['apiKey'] as const,
  },
  sms: {
    settings: z.object({
      /** log: never send, only write to the message log; mimsms: send with MiMSMS. */
      provider: z.enum(['log', 'mimsms']).catch('log').default('log'),
      /** MiMSMS: the email you sign in to sms.mimsms.com with. */
      userName: email,
      /** MiMSMS: the Sender ID (sms.mimsms.com → Utility → Sender ID), a name or a number. */
      senderId: text(20),
      /** Test mode: SMS go only to the test numbers (the rest are only written to the log). Always on away from the live server. */
      testMode: z.boolean().default(true),
      testNumbers: z
        .array(z.string().trim().transform((v) => v.replace(/[\s()-]/g, '').replace(/^\+?880/, '0')).refine((v) => /^01\d{9}$/.test(v), { error: 'A mobile number like 01712345678' }))
        .max(10, { error: 'At most 10' })
        .default([]),
    }),
    secrets: ['apiKey'] as const,
  },
  google: {
    // Firebase web settings: public by design (they are in every page that signs in). No secrets.
    settings: z.object({
      enabled: z.boolean().default(false),
      apiKey: text(100),
      authDomain: text(200),
      projectId: text(100),
      appId: text(200),
    }),
    secrets: [] as const,
  },
  payment: {
    settings: z.object({
      /** SSLCommerz (bKash, Nagad, cards). Not switched on until the shop's merchant account is ready. */
      enabled: z.boolean().default(false),
      sandbox: z.boolean().default(true),
      storeId: text(100),
    }),
    secrets: ['storePassword'] as const,
  },
} satisfies Record<(typeof INTEGRATION_KEYS)[number], { settings: z.ZodObject; secrets: readonly string[] }>;

export type IntegrationKey = keyof typeof INTEGRATIONS;
export type IntegrationSettings<K extends IntegrationKey> = z.infer<(typeof INTEGRATIONS)[K]['settings']>;

export const integrationKeyParam = z.object({ key: z.enum(INTEGRATION_KEYS) });

/** Saving: settings in full; a secret is only changed when sent (a new value, or null to remove). */
export const integrationBody = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    secrets: z.record(z.string(), z.string().trim().max(500).nullable()).default({}),
  })
  .meta({ id: 'IntegrationBody' });

export const testBody = z
  .object({ to: z.string().trim().min(3).max(200).meta({ description: 'Email address (email) or phone number (sms)' }) })
  .meta({ id: 'IntegrationTestBody' });

export const messageListQuery = z.object({
  channel: z.enum(['email', 'sms', 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const integrationView = z
  .object({
    key: z.enum(INTEGRATION_KEYS),
    settings: z.record(z.string(), z.unknown()),
    /** Per secret field: null when not saved, else a short hint like "re_…a3f9". */
    secrets: z.record(z.string(), z.string().nullable()),
    /** ready: will be used; test: test mode; off: not used. */
    state: z.enum(['ready', 'test', 'off', 'incomplete']),
    updatedAt: z.date().nullable(),
    updatedBy: z.string().nullable(),
  })
  .meta({ id: 'Integration' });
