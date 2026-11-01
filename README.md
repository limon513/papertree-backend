# PaperTree Backend

API for the PaperTree Bangladesh store and admin panel.
Node 24+ (runs TypeScript directly), Express 5, PostgreSQL 17, Drizzle ORM, zod.

## First-time setup

1. Install **PostgreSQL 17** locally (Redis is optional; the API works without it).
2. Create the database and its user (run in `psql` as the `postgres` superuser):
   ```sql
   CREATE ROLE papertree WITH LOGIN PASSWORD 'papertree';
   CREATE DATABASE papertree OWNER papertree;
   ```
3. Copy the env file and adjust if needed:
   ```
   cp .env.example .env
   ```
4. Create the tables and add the first Super Admin:
   ```
   npm install
   npm run db:migrate
   npm run db:seed
   ```
5. Run the API:
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
