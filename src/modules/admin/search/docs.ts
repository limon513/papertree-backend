import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import { searchReport, searchReportQuery, synonymBody, synonymView } from './schemas.ts';

const tags = ['Admin: Search'];
const security = adminAuth;
const synonyms = 'Needs the Products section. Words are cleaned the way search reads them (lower case, punctuation as spaces). Search uses changes at once on this server, and within 5 minutes on others.';

export const searchDocs: ZodOpenApiPathsObject = {
  '/v1/admin/search-synonyms': {
    get: {
      tags,
      security,
      summary: 'List synonym groups',
      description: `${synonyms} Each group lists words that mean the same to shoppers ("khata" = notebook).`,
      responses: { '200': json(z.array(synonymView)), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a synonym group',
      description: `${synonyms} 409 if a word is already in another group.`,
      requestBody: jsonBody(synonymBody),
      responses: { '201': json(synonymView, 'Added'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/search-synonyms/{id}': {
    put: {
      tags,
      security,
      summary: 'Change a synonym group',
      description: `${synonyms} 409 if a word is already in another group.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(synonymBody),
      responses: { '200': json(synonymView), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Remove a synonym group',
      description: synonyms,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(401, 403, 404) },
    },
  },
  '/v1/admin/search-report': {
    get: {
      tags,
      security,
      summary: 'What shoppers searched for',
      description:
        'Needs the Reports section. Searches made on the website in the last 7, 30 or 90 days: the most searched words, ' +
        'searches that found nothing (worth stocking, or adding a synonym), and typos that were fixed. Up to 50 of each; the same words in any case count together.',
      requestParams: { query: searchReportQuery },
      responses: { '200': json(searchReport), ...errors(400, 401, 403) },
    },
  },
};
