import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { media } from './media.ts';
import { id, ref, timestamps, timestamptz } from './_helpers.ts';

export const BANNER_PLACEMENTS = ['hero', 'tile'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

/**
 * Home page banners, managed in the admin (Website Content).
 * - hero: the big slider at the top (pictures 2:1, e.g. 1200 × 600).
 * - tile: up to two smaller offers beside the slider on computers, under it on phones (2:1, e.g. 600 × 300).
 * Shown while active and between the optional start and end. GIFs keep moving.
 */
export const banners = pgTable(
  'banners',
  {
    id: id(),
    placement: text('placement').$type<BannerPlacement>().notNull(),
    /** Staff's name for it; also the picture's description for screen readers and Google. */
    title: text('title').notNull(),
    imageId: ref('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A picture made for phones (same 2:1 shape, bigger text). Optional: else the main picture. */
    mobileImageId: ref('mobile_image_id').references(() => media.id, { onDelete: 'set null' }),
    /** Where a tap goes: a page of this site ("/deals/") or a full address. */
    linkUrl: text('link_url'),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('banners_placement_idx').on(t.placement, t.sortOrder)],
);

/**
 * Content pages: About us, Contact, Terms, Refund policy, Privacy... at /<slug>/ (the old site's
 * addresses are kept, e.g. /terms-and-condition/). Written in the admin (Website Content > Pages).
 */
export const pages = pgTable('pages', {
  id: id(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  /** Cleaned HTML from the editor. */
  body: text('body'),
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  /** Drafts are only seen in the admin. */
  isPublished: boolean('is_published').notNull().default(false),
  /** Linked in the website footer. */
  showInFooter: boolean('show_in_footer').notNull().default(true),
  /** Shows the shop's phone, WhatsApp, email, address and hours (from Settings) under the text. */
  showContact: boolean('show_contact').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});
