import { z } from 'zod';
import { BANNER_PLACEMENTS } from '../../../db/schema/index.ts';
import { mediaSchema } from '../media/schemas.ts';

/** A page of this site ("/deals/") or a full https address. */
const link = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .transform((v) => v || null)
  .refine((v) => v === null || /^\/(?!\/)/.test(v) || /^https?:\/\/\S+$/i.test(v), {
    error: 'Use a page of this site like /deals/, or a full address starting with https://',
  });

const when = z.iso.datetime({ offset: true }).nullable().default(null);

export const bannerBody = z
  .object({
    placement: z.enum(BANNER_PLACEMENTS).meta({ description: 'hero: the top slider; tile: a smaller offer beside it' }),
    title: z.string({ error: 'Give it a name' }).trim().min(1, { error: 'Give it a name' }).max(120),
    imageId: z.number({ error: 'Upload the picture' }).int().positive(),
    mobileImageId: z.number().int().positive().nullable().default(null),
    linkUrl: link.default(null),
    startsAt: when,
    endsAt: when,
    isActive: z.boolean().default(true),
  })
  .refine((b) => !b.startsAt || !b.endsAt || new Date(b.endsAt) > new Date(b.startsAt), {
    error: 'The end must be after the start',
    path: ['endsAt'],
  })
  .meta({ id: 'BannerBody' });
export type BannerInput = z.infer<typeof bannerBody>;

export const bannerOrderBody = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(100).meta({ description: 'Banner ids of one placement, first shown first' }) })
  .meta({ id: 'BannerOrder' });

export const bannerView = z
  .object({
    id: z.number(),
    placement: z.enum(BANNER_PLACEMENTS),
    title: z.string(),
    image: mediaSchema.nullable(),
    mobileImage: mediaSchema.nullable(),
    linkUrl: z.string().nullable(),
    startsAt: z.date().nullable(),
    endsAt: z.date().nullable(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    /** live: shown now; scheduled: starts later; ended; hidden: switched off; no_picture: its picture is gone. */
    state: z.enum(['live', 'scheduled', 'ended', 'hidden', 'no_picture']),
  })
  .meta({ id: 'Banner' });
