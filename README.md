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
| `npm run worker` | Run only the background jobs (product imports), for production with `JOB_WORKERS=false` on the API |
| `npm run db:seed-demo` | Add the sample shop: categories, brands and 43 products with pictures (safe to run again; existing items are skipped) |
| `npm run icons:build` | Write `public/icons/*.svg` after changing the list in `src/lib/catalog-icons.ts` |
| `npm run locations:build` | Write `src/data/bd-locations.json` (districts and areas of Bangladesh) |

## Images and icons

- Uploads (`POST /v1/admin/media`) are saved as WebP in widths 160, 400, 800 and 1600.
  With `STORAGE_DRIVER=local` they go to `uploads/` and are served at `/uploads`;
  with `STORAGE_DRIVER=s3` they go to S3-compatible storage (set the `S3_*` values):
  Neon Object Storage for the demo (bucket with **public_read** access), AWS S3 or similar in production.
- Category and brand icons are SVG files in `public/icons`, served at `/icons/{key}.svg`.
  They come from Fluent Emoji by Microsoft (MIT licence).

## Background jobs

Long tasks like product imports run as background jobs, stored in PostgreSQL by
[pg-boss](https://github.com/timgit/pg-boss) (schema `pgboss`), so no Redis is needed.

- Demo and development: the API runs the jobs itself (`JOB_WORKERS=true`, the default).
- Production: run the API with `JOB_WORKERS=false` and one or more `npm run worker` processes under PM2.
- A job that was running when the server restarted continues where it stopped.

## Product imports

`POST /v1/admin/imports/products` takes a CSV or Excel (.xlsx) file: the PaperTree template
(`GET /v1/admin/imports/template.csv`), a WooCommerce product export, or the Daraz Seller Center exports
("basic" and "price & stock", sent together as two `file` parts; the Seller SKU becomes our SKU, so a later
price & stock export with "update" refreshes prices and stock). Every product is checked first (new, update
by SKU, skip, or problem); nothing is imported until `POST /v1/admin/imports/{id}/start`. Image links in the
file are downloaded (public addresses only) and stored like uploads.

**From a link:** `POST /v1/admin/imports/link/read` reads one product page from another shop and returns
what it found (nothing is saved); `POST /v1/admin/imports/link` saves the checked result as a draft.
It uses the WooCommerce Store API or Shopify's product data when the shop has them, the data embedded
in Daraz pages, and otherwise the standard schema.org / Open Graph tags most shops have. AliExpress
only shares the name and main picture with servers.

## Settings and delivery charges

Shop settings live in the `settings` table, one JSON row per section (`store`, `checkout`); fields that were
never saved fall back to the defaults in `modules/admin/settings/schemas.ts`.

Delivery charges come from `delivery_zones`. An order uses the zone that lists its area, else the zone that
lists its district, else the default zone. A zone can be free from an order amount and charge extra for every
started kg above an included weight; wholesale orders can follow their own rule (Settings > Payments &
wholesale). Places are ids from `src/data/bd-locations.json`: the 64 districts and 494 upazilas from
[bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode) (MIT), plus the Dhaka City thanas.

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
