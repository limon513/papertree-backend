import { bigint, timestamp } from 'drizzle-orm/pg-core';

/** Auto-increment bigint primary key. */
export const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/** Bigint foreign key column. */
export const ref = (name: string) => bigint(name, { mode: 'number' });

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = {
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
