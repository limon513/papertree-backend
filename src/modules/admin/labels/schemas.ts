import { z } from 'zod';
import { LABEL_COLORS } from '../../../db/schema/index.ts';
import { slugInput } from '../schemas.ts';

const name = z
  .string({ error: 'Enter the tag name' })
  .trim()
  .min(1, { error: 'Enter the tag name' })
  .max(30, { error: 'Keep it short: at most 30 letters' });

export const labelBody = z
  .object({
    name: name.meta({ example: 'Overseas' }),
    slug: slugInput.optional().meta({ description: 'For the filter link (?tag=overseas). Empty: made from the name.' }),
    color: z.enum(LABEL_COLORS).default('green'),
    showOnCards: z.boolean().default(true).meta({ description: 'Badge on product cards (always on the product page)' }),
    isActive: z.boolean().default(true).meta({ description: 'Off: hidden on the website, kept on the products' }),
    sortOrder: z.number().int().min(0).max(9999).default(0).meta({ description: 'Smaller first' }),
  })
  .meta({ id: 'LabelBody' });

export type LabelInput = z.infer<typeof labelBody>;

export const labelSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
    color: z.enum(LABEL_COLORS),
    showOnCards: z.boolean(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    productCount: z.number(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Label' });

export const labelList = z.object({ items: z.array(labelSchema) }).meta({ id: 'LabelList' });
