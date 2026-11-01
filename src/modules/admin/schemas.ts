import { z } from 'zod';
import { ICON_KEYS } from '../../lib/catalog-icons.ts';
import { slugify } from '../../lib/slug.ts';

export const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }))
  .meta({ format: 'email' });

export const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(8, { error: 'Password must be at least 8 characters' })
  .max(200, { error: 'Password is too long' });

export const nameSchema = z
  .string({ error: 'Name is required' })
  .trim()
  .min(2, { error: 'Name must be at least 2 characters' })
  .max(100, { error: 'Name is too long' });

/** Optional text. Empty becomes null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Must be ${max} characters or less` })
    .nullable()
    .transform((v) => v || null);

/** Cleaned into a URL-safe slug. Empty means "make one from the name". */
export const slugInput = z
  .string()
  .trim()
  .max(120, { error: 'URL name is too long' })
  .transform(slugify)
  .meta({ description: 'URL name, e.g. "art-paper". Leave empty to make it from the name.' });

/** An uploaded image and/or an icon. The website shows the image if there is one, otherwise the icon. */
export const pictureFields = {
  imageId: z
    .number({ error: 'Upload the image again' })
    .int()
    .positive()
    .nullable()
    .meta({ description: 'Id from POST /v1/admin/media. null = no image.' }),
  icon: z
    .string()
    .refine((key) => ICON_KEYS.includes(key), { error: 'Choose an icon from the list' })
    .nullable()
    .meta({ description: 'Icon key from GET /v1/admin/icons. null = no icon.' }),
};

export const seoFields = {
  seoTitle: optionalText(200).meta({ description: 'Page title for Google. Empty = use the name.' }),
  seoDescription: optionalText(500).meta({ description: 'Short text shown under the title in Google.' }),
};
