import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    ADMIN_APP_URL: z.string().min(1).default('http://localhost:5173'),
    /** The website (storefront); its browser calls (search, cart) are allowed. */
    STOREFRONT_URL: z.string().min(1).default('http://localhost:3000'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    API_DOCS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /** Run background jobs (imports) inside the API process. false when separate workers run them. */
    JOB_WORKERS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Seconds before a customer hears that their order moved on: time for staff to undo a wrong click. */
    ORDER_MESSAGE_DELAY: z.coerce.number().int().min(0).max(3600).default(60),
    /** Steadfast courier API (tests point it at a fake server). */
    STEADFAST_URL: z.string().url().default('https://portal.packzy.com/api/v1'),
    /** Away from the live server the real Steadfast is never called (real parcels!), unless this is true. */
    STEADFAST_ALLOW_REAL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Uploaded images: any S3-compatible storage (Neon Object Storage, AWS S3, ...),
    // or the local uploads/ folder when S3 is not set up.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    /** e.g. https://br-xxx.storage.c-4.ap-southeast-1.aws.neon.tech or https://s3.ap-southeast-1.amazonaws.com */
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    /** Bucket in the URL path (endpoint/bucket/key). Neon needs this; AWS accepts both. */
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * Public address of the stored files. With S3 it defaults to the bucket's own address;
     * set it when a CDN or custom domain sits in front.
     */
    MEDIA_PUBLIC_URL: z.string().optional(),

    /**
     * Master key for secrets saved in the admin (email and SMS API keys, payment passwords):
     * 32 random bytes, base64. The same key on every server that shares the database.
     * Make one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     */
    SECRETS_KEY: z
      .string()
      .optional()
      .refine((v) => !v || Buffer.from(v, 'base64').length === 32, 'SECRETS_KEY must be 32 bytes, base64'),
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_DRIVER !== 's3') return;
    for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!e[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
