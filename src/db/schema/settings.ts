import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin.ts';
import { id, ref, timestamps } from './_helpers.ts';

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

/**
 * Shop settings, one row per section ("store", "checkout"). The value's shape is defined and
 * checked in modules/admin/settings/schemas.ts; missing fields fall back to the defaults there.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: ref('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  ...timestamps,
});

/**
 * Delivery charges by place. An order goes to the zone that lists its area, else the zone that
 * lists its district, else the default zone ("rest of Bangladesh").
 * Places are ids from src/data/bd-locations.json.
 */
export const deliveryZones = pgTable(
  'delivery_zones',
  {
    id: id(),
    name: text('name').notNull().unique(),
    fee: money('fee').notNull(),
    /** Orders of this amount or more are delivered free. null = never free. */
    freeAbove: money('free_above'),
    /** Weight included in the fee. Every started kg above it costs extraPerKg. null = no weight charge. */
    includedKg: numeric('included_kg', { precision: 6, scale: 2, mode: 'number' }),
    extraPerKg: money('extra_per_kg'),
    /** Shown to customers, e.g. "1–2 days". */
    deliveryTime: text('delivery_time'),
    districtIds: text('district_ids').array().notNull().default([]),
    areaIds: text('area_ids').array().notNull().default([]),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  // Only one default zone.
  (t) => [uniqueIndex('delivery_zones_one_default_idx').on(t.isDefault).where(sql`${t.isDefault}`)],
);
