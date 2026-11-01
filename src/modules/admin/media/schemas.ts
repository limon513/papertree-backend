import { z } from 'zod';

export const MAX_UPLOAD_MB = 10;

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
];

export const uploadBody = z
  .object({
    file: z.string().meta({ format: 'binary', description: `JPG, PNG, WebP, AVIF, GIF or SVG, up to ${MAX_UPLOAD_MB} MB` }),
  })
  .meta({ id: 'UploadMediaBody' });

// ---- Responses (used for docs) ----

export const mediaSchema = z
  .object({
    id: z.number(),
    url: z.string().meta({ description: 'Largest saved size' }),
    urls: z
      .record(z.string(), z.string())
      .meta({ description: 'URL per saved width', example: { '160': 'https://…-160.webp', '400': 'https://…-400.webp' } }),
    width: z.number(),
    height: z.number(),
    alt: z.string().nullable(),
    originalName: z.string().nullable(),
  })
  .meta({ id: 'Media' });

export const iconList = z
  .object({
    groups: z.array(
      z.object({
        label: z.string(),
        icons: z.array(z.object({ key: z.string(), label: z.string() })),
      }),
    ),
  })
  .meta({ id: 'IconList', description: 'Icon files are at /icons/{key}.svg on the API address' });
