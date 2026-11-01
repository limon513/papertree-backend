# PaperTree Backend

API for the PaperTree Bangladesh store and admin panel.
Node 26 (runs TypeScript directly), Express 5, PostgreSQL, Drizzle ORM, zod.

## First-time setup

1. Get a PostgreSQL database: a Neon database, or local **PostgreSQL 17**. For local, create
   the database and its user (run in `psql` as the `postgres` superuser):
   ```sql
   CREATE ROLE papertree WITH LOGIN PASSWORD 'papertree';
   CREATE DATABASE papertree OWNER papertree;
   ```
2. Copy the env file and set `DATABASE_URL`:
   ```
   cp .env.example .env
   ```
3. Create the tables and add the first Super Admin:
   ```
   npm install
   npm run db:migrate
   npm run db:seed
   ```
4. Run the API:
   ```
   npm run dev
   ```
   - API: http://localhost:4000
   - Interactive API docs: http://localhost:4000/docs
     (use **Sign in** first; the session cookie is then used for the other calls)

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the API, restart on file changes |
| `npm run typecheck` | Check types |
| `npm run db:generate` | Create a new migration after changing `src/db/schema` |
| `npm run db:migrate` | Apply migrations to the database |
| `npm run db:seed` | Create the Super Admin role and first admin (safe to run again) |
| `npm run db:studio` | Browse the database in the browser |

## Redis

Redis is optional. Without it everything still works:

- Admin sessions live in PostgreSQL.
- Rate limits are kept in memory (fine for one process, like the Render demo).
- Future caching and background jobs fall back to PostgreSQL when Redis is not set.

On the production VPS (several PM2 processes) Redis is used for shared cache and rate limits.

## Demo deploy (Render)

`render.yaml` describes the service. In Render: **New > Blueprint**, pick this repo, then fill in
`DATABASE_URL`: the Neon connection string (with `sslmode=verify-full`).

Then add the custom domain `papertree-api.bitnbyteit.com`. The admin panel is at
`papertree-admin.bitnbyteit.com`. Both must be on the same main domain so the sign-in cookie works.

Free plan notes: the API sleeps after 15 minutes without visits, and the first request after
that takes up to a minute.

## Folder layout

```
src/
  config/      env settings (validated on start)
  db/          database client, schema, migrate and seed scripts
  docs/        OpenAPI document and shared doc helpers
  lib/         small helpers (errors, logger, passwords, audit log)
  middleware/  auth checks and error handling
  modules/     features, one folder each: routes.ts, schemas.ts, docs.ts
```

Request validation and API docs use the same zod schemas, so they stay in sync.
