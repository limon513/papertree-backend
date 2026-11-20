import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { customers } from './customers.ts';
import { media } from './media.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

/**
 * A browser or phone that allowed push notifications: its Firebase Cloud Messaging token. A signed-in
 * shopper's devices belong to them (order updates, saved items); every device can get the shop's offers.
 */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: id(),
    customerId: ref('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    /** The Firebase Cloud Messaging registration token (secret-ish: whoever has it can send to the device). */
    token: text('token').notNull(),
    /** "Chrome on Android", so a customer can tell their devices apart. */
    device: text('device'),
    /** Sends that failed in a row (the device is dropped when Firebase says the token is gone). */
    failures: integer('failures').notNull().default(0),
    lastSentAt: timestamptz('last_sent_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('push_devices_token_idx').on(t.token), index('push_devices_customer_id_idx').on(t.customerId)],
);

export const PUSH_CAMPAIGN_STATUSES = ['scheduled', 'sending', 'sent', 'cancelled'] as const;
export type PushCampaignStatus = (typeof PUSH_CAMPAIGN_STATUSES)[number];

/**
 * An offer or news sent by push to everyone who keeps offers on. Never at night, and with a gap
 * between offers (push/campaigns.ts). Sent in batches by the background workers; the counts add up
 * as the batches finish.
 */
export const pushCampaigns = pgTable(
  'push_campaigns',
  {
    id: id(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Where a tap opens: a page on the website. */
    url: text('url').notNull(),
    imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
    status: text('status').$type<PushCampaignStatus>().notNull().default('scheduled'),
    /** When it goes out (moved out of night hours when needed). */
    sendAt: timestamptz('send_at').notNull(),
    /** Devices it was meant for, when sending started. */
    targeted: integer('targeted').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** Devices that no longer take alerts (dropped while sending). */
    removed: integer('removed').notNull().default(0),
    taps: integer('taps').notNull().default(0),
    batches: integer('batches').notNull().default(0),
    batchesDone: integer('batches_done').notNull().default(0),
    createdBy: ref('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    ...timestamps,
  },
  (t) => [index('push_campaigns_send_at_idx').on(t.sendAt)],
);
