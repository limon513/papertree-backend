import { z } from 'zod';
import { mediaSchema } from '../media/schemas.ts';
import { optionalText, pictureFields, seoFields, slugInput } from '../schemas.ts';

const brandName = z
  .string({ error: 'Name is required' })
  .trim()
  .min(1, { error: 'Name is required' })
  .max(100, { error: 'Name is too long' });

export const createBrandBody = z
  .object({
    name: brandName,
    slug: slugInput.optional(),
    description: optionalText(5000).optional(),
    imageId: pictureFields.imageId.optional(),
    icon: pictureFields.icon.optional(),
    isActive: z.boolean().default(true).meta({ description: 'Shown on the website' }),
    isFeatured: z.boolean().default(false).meta({ description: 'Shown first in the brand shop' }),
    seoTitle: seoFields.seoTitle.optional(),
    seoDescription: seoFields.seoDescription.optional(),
  })
  .meta({ id: 'CreateBrandBody' });

export const updateBrandBody = z
  .object({
    name: brandName.optional(),
    slug: slugInput.optional(),
    description: optionalText(5000).optional(),
    imageId: pictureFields.imageId.optional(),
    icon: pictureFields.icon.optional(),
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    seoTitle: seoFields.seoTitle.optional(),
    seoDescription: seoFields.seoDescription.optional(),
  })
  .meta({ id: 'UpdateBrandBody' });

// ---- Responses (used for docs) ----

export const brand = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageId: z.number().nullable(),
    image: mediaSchema.nullable(),
    icon: z.string().nullable(),
    isActive: z.boolean(),
    isFeatured: z.boolean(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Brand' });

export const brandList = z
  .object({ items: z.array(brand).meta({ description: 'All brands, sorted by name' }) })
  .meta({ id: 'BrandList' });
