import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.ts';
import * as schema from './schema/index.ts';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
