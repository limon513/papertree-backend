import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import {
  category,
  categoryList,
  createCategoryBody,
  MAX_CATEGORY_DEPTH,
  reorderCategoriesBody,
  updateCategoryBody,
} from './schemas.ts';

const tags = ['Admin: Categories'];
const security = adminAuth;
const access = 'Needs the Products section.';

export const categoriesDocs: ZodOpenApiPathsObject = {
  '/v1/admin/categories': {
    get: {
      tags,
      security,
      summary: 'List categories',
      description: `${access} Returns every category as a flat list. Build the tree with parentId.`,
      responses: { '200': json(categoryList), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Create a category',
      description: `${access} Up to ${MAX_CATEGORY_DEPTH} levels deep. Added at the end of its parent's list.`,
      requestBody: jsonBody(createCategoryBody),
      responses: { '201': json(category, 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/categories/reorder': {
    post: {
      tags,
      security,
      summary: 'Reorder categories',
      description: `${access} Send every category under one parent in the new order.`,
      requestBody: jsonBody(reorderCategoriesBody),
      responses: { '204': noContent, ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/categories/{id}': {
    get: {
      tags,
      security,
      summary: 'Get a category',
      requestParams: { path: idParam },
      responses: { '200': json(category), ...errors(401, 403, 404) },
    },
    patch: {
      tags,
      security,
      summary: 'Update a category',
      description: `${access} Changing parentId moves it (and its sub-categories). An empty slug makes a new one from the name.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateCategoryBody),
      responses: { '200': json(category), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a category',
      description: `${access} Not allowed while it has sub-categories.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
};
