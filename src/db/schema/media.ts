import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { customers } from './customers.ts';
import { id, ref, timestamptz } from './_helpers.ts';

/**
 * An uploaded image. Each one is saved as WebP in a few widths,
 * at "{keyBase}-{width}.webp" (e.g. media/2026/11/x7k2p9-faber-logo-400.webp).
 */
export const media = pgTable('media', {
  id: id(),
  keyBase: text('key_base').notNull().unique(),
  /** Widths that were saved, smallest first. The last one is the full image. */
  widths: integer('widths').array().notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  /** Total bytes of all saved widths. */
  sizeBytes: integer('size_bytes').notNull(),
  originalName: text('original_name'),
  alt: text('alt'),
  uploadedBy: ref('uploaded_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  /** A customer's own upload (a review photo): only they can attach it. */
  customerId: ref('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
