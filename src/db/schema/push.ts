import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { customers } from './customers.ts';
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
