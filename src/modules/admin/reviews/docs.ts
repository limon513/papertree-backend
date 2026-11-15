import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { reviewBody } from '../../store/reviews.ts';
import { rejectBody, replyBody, reviewListQuery } from './routes.ts';

const open = z.object({}).catchall(z.unknown());
const adminTags = ['Admin: Reviews'];
const storeTags = ['Store: reviews'];
const access = 'Needs the Products section.';
const signedIn = "Needs the shopper's sign-in cookie.";

export const reviewsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/reviews': {
    get: {
      tags: adminTags,
      security: adminAuth,
      summary: 'Reviews to approve, reject or answer',
      description: `${access} By status (pending first), newest change first, 20 a page; counts per status.`,
      requestParams: { query: reviewListQuery },
      responses: { '200': json(open.meta({ id: 'AdminReviewList' })), ...errors(401, 403) },
    },
  },
  '/v1/admin/reviews/{id}/approve': {
    post: { tags: adminTags, security: adminAuth, summary: 'Approve a review (it shows on the website)', requestParams: { path: idParam }, responses: { '200': json(open), ...errors(401, 403, 404) } },
  },
  '/v1/admin/reviews/{id}/reject': {
    post: { tags: adminTags, security: adminAuth, summary: 'Reject a review', description: 'The reason is for staff only.', requestParams: { path: idParam }, requestBody: jsonBody(rejectBody), responses: { '200': json(open), ...errors(401, 403, 404) } },
  },
  '/v1/admin/reviews/{id}/reply': {
    put: { tags: adminTags, security: adminAuth, summary: "The shop's answer under a review", description: 'null removes it.', requestParams: { path: idParam }, requestBody: jsonBody(replyBody), responses: { '200': json(open), ...errors(400, 401, 403, 404) } },
  },
  '/v1/admin/reviews/{id}': {
    delete: { tags: adminTags, security: adminAuth, summary: 'Delete a review', requestParams: { path: idParam }, responses: { '204': noContent, ...errors(401, 403, 404) } },
  },
  '/v1/store/products/{slug}/reviews': {
    get: {
      tags: storeTags,
      summary: "A product's reviews",
      description: 'Approved reviews, newest first, 10 a page (stars=1..5 filters), with the summary: average, count and how many per star. Names are shortened ("Nusrat J."). Cached a minute.',
      requestParams: { path: z.object({ slug: z.string() }), query: z.object({ page: z.number().optional(), stars: z.number().optional() }) },
      responses: { '200': json(open.meta({ id: 'StoreReviewList' })), ...errors(404) },
    },
  },
  '/v1/store/me/reviews/{productId}': {
    get: {
      tags: storeTags,
      summary: 'Can I review this product, and my review',
      description: 'canReview: they received it (a delivered order). reason: sign_in or not_delivered. review: theirs, any status.',
      requestParams: { path: z.object({ productId: z.number() }) },
      responses: { '200': json(open), ...errors(404) },
    },
  },
  '/v1/store/me/reviewable': {
    get: { tags: storeTags, summary: 'Products I received and have not reviewed', description: signedIn, responses: { '200': json(open), ...errors(401) } },
  },
  '/v1/store/me/review-photos': {
    post: {
      tags: storeTags,
      summary: 'Upload a review photo',
      description: `${signedIn} multipart "file": JPG, PNG or WebP up to 8 MB (redrawn as WebP, which drops location data). Answers its id to send with the review. 30 writes an hour.`,
      responses: { '201': json(open), ...errors(400, 401, 429) },
    },
  },
  '/v1/store/me/reviews': {
    post: {
      tags: storeTags,
      summary: 'Write or change my review',
      description: `${signedIn} Only for a product they received. Up to 2 of their own photos. A new or changed review waits for staff. 409 when they have not received it.`,
      requestBody: jsonBody(reviewBody),
      responses: { '200': json(open), '201': json(open, 'Created'), ...errors(400, 401, 404, 409, 429) },
    },
  },
  '/v1/store/me/reviews/{id}': {
    delete: { tags: storeTags, summary: 'Delete my review', description: signedIn, requestParams: { path: idParam }, responses: { '204': noContent, ...errors(401, 404) } },
  },
};
