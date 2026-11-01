import { z } from 'zod';
import { mediaSchema } from '../media/schemas.ts';
import { optionalText, pictureFields, seoFields, slugInput } from '../schemas.ts';

export const MAX_CATEGORY_DEPTH = 3;

const categoryName = z
  .string({ error: 'Name is required' })
  .trim()
  .min(2, { error: 'Name must be at least 2 characters' })
  .max(100, { error: 'Name is too long' });

const parentId = z
  .number({ error: 'Choose a valid parent category' })
  .int()
  .positive()
  .nullable()
  .meta({ description: 'Parent category id. null = top level.' });

export const createCategoryBody = z
  .object({
    name: categoryName,
    slug: slugInput.optional(),
    parentId: parentId.default(null),
    description: optionalText(5000).optional(),
    imageId: pictureFields.imageId.optional(),
    icon: pictureFields.icon.optional(),
    isActive: z.boolean().default(true).meta({ description: 'Shown on the website' }),
    seoTitle: seoFields.seoTitle.optional(),
    seoDescription: seoFields.seoDescription.optional(),
  })
  .meta({ id: 'CreateCategoryBody' });

export const updateCategoryBody = z
  .object({
    name: categoryName.optional(),
    slug: slugInput.optional(),
    parentId: parentId.optional(),
    description: optionalText(5000).optional(),
    imageId: pictureFields.imageId.optional(),
    icon: pictureFields.icon.optional(),
    isActive: z.boolean().optional(),
    seoTitle: seoFields.seoTitle.optional(),
    seoDescription: seoFields.seoDescription.optional(),
  })
  .meta({ id: 'UpdateCategoryBody' });

export const reorderCategoriesBody = z
  .object({
    parentId: parentId,
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .meta({ description: 'All categories under this parent, in the new order' }),
  })
  .meta({ id: 'ReorderCategoriesBody' });

// ---- Responses (used for docs) ----

export const category = z
  .object({
    id: z.number(),
    parentId: z.number().nullable(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageId: z.number().nullable(),
    image: mediaSchema.nullable(),
    icon: z.string().nullable(),
    sortOrder: z.number(),
    isActive: z.boolean(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Category' });

export const categoryList = z
  .object({ items: z.array(category).meta({ description: 'All categories, flat, sorted by sortOrder then name' }) })
  .meta({ id: 'CategoryList' });
