import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { mediaSchema } from '../media/schemas.ts';
import { adminAuth, errors, idParam, json, jsonBody, noContent } from '../../../docs/common.ts';
import {
  checkoutSettings,
  checkoutSettingsSchema,
  locationsSchema,
  MESSAGE_EVENTS,
  messagesSettings,
  quoteBody,
  quoteSchema,
  settingsResponse,
  stockLocationBody,
  stockLocationSchema,
  storeSettings,
  storeSettingsSchema,
  zoneBody,
  zoneSchema,
} from './schemas.ts';

const tags = ['Admin: Settings'];
const security = adminAuth;
const access = 'Needs the Settings section.';

export const settingsDocs: ZodOpenApiPathsObject = {
  '/v1/admin/settings': {
    get: {
      tags,
      security,
      summary: 'Get the shop settings',
      description: `${access} Fields never saved come back with their defaults.`,
      responses: { '200': json(settingsResponse), ...errors(401, 403) },
    },
  },
  '/v1/admin/settings/store': {
    put: {
      tags,
      security,
      summary: 'Save the store details',
      description: `${access} Name, contact details, address, logo and social links, shown on the website and invoices.`,
      requestBody: jsonBody(storeSettings),
      responses: { '200': json(storeSettingsSchema), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/settings/checkout': {
    put: {
      tags,
      security,
      summary: 'Save the payment and wholesale terms',
      description: `${access} Cash on delivery, wholesale advance, minimum order and wholesale delivery.`,
      requestBody: jsonBody(checkoutSettings),
      responses: { '200': json(checkoutSettingsSchema), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/settings/messages': {
    put: {
      tags,
      security,
      summary: 'Save which customer messages go out',
      description: `${access} For each order step (placed, confirmed, shipped, delivered, cancelled): SMS and/or email. SMS cost money.`,
      requestBody: jsonBody(messagesSettings),
      responses: { '200': json(messagesSettings), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/settings/messages/samples': {
    get: {
      tags,
      security,
      summary: 'Example SMS for each order step',
      description: `${access} Made-up order, the shop's own name and phone. Plain English letters, at most 160 (one SMS).`,
      responses: { '200': json(z.record(z.enum(MESSAGE_EVENTS), z.string())), ...errors(401, 403) },
    },
  },
  '/v1/admin/store-info': {
    get: {
      tags,
      security,
      summary: 'Store details for invoices',
      description: 'Any signed-in staff. The store details and logo, read-only.',
      responses: {
        '200': json(z.object({ store: storeSettingsSchema, logo: mediaSchema.nullable() }).meta({ id: 'StoreInfo' })),
        ...errors(401),
      },
    },
  },
  '/v1/admin/places': {
    get: {
      tags,
      security,
      summary: 'Divisions, districts and areas of Bangladesh',
      description:
        'Any signed-in staff. Areas are upazilas plus the Dhaka City thanas (city: true). Ids are used by delivery zones and order addresses.',
      responses: { '200': json(locationsSchema), ...errors(401, 403) },
    },
  },
  '/v1/admin/settings/delivery-zones': {
    get: {
      tags,
      security,
      summary: 'List delivery zones',
      description: access,
      responses: { '200': json(z.object({ items: z.array(zoneSchema) })), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a delivery zone',
      description: `${access} A district or area can be in only one active zone.`,
      requestBody: jsonBody(zoneBody),
      responses: { '201': json(zoneSchema, 'Added'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/settings/delivery-zones/{id}': {
    put: {
      tags,
      security,
      summary: 'Change a delivery zone',
      description: `${access} The default zone cannot be turned off.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(zoneBody),
      responses: { '200': json(zoneSchema), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a delivery zone',
      description: `${access} The default zone cannot be deleted.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/settings/delivery-quote': {
    post: {
      tags,
      security,
      summary: 'Work out a delivery charge',
      description:
        `${access} Uses the area's zone, else the district's, else the default zone. ` +
        'Free above the zone amount; every started kg above the included weight is charged extra; wholesale terms apply when wholesale is true.',
      requestBody: jsonBody(quoteBody),
      responses: { '200': json(quoteSchema), ...errors(400, 401, 403) },
    },
  },
  '/v1/admin/settings/stock-locations': {
    get: {
      tags,
      security,
      summary: 'List stock locations',
      description: `${access} All locations, including turned-off ones, with the stock units kept in each.`,
      responses: { '200': json(z.object({ items: z.array(stockLocationSchema) })), ...errors(401, 403) },
    },
    post: {
      tags,
      security,
      summary: 'Add a stock location',
      description: access,
      requestBody: jsonBody(stockLocationBody),
      responses: { '201': json(stockLocationSchema, 'Added'), ...errors(400, 401, 403, 409) },
    },
  },
  '/v1/admin/settings/stock-locations/{id}': {
    put: {
      tags,
      security,
      summary: 'Rename or turn a stock location on/off',
      description: `${access} The default location cannot be turned off.`,
      requestParams: { path: idParam },
      requestBody: jsonBody(stockLocationBody),
      responses: { '200': json(stockLocationSchema), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags,
      security,
      summary: 'Delete a stock location',
      description: `${access} Only a location that never held stock. Otherwise turn it off.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
  '/v1/admin/settings/stock-locations/{id}/default': {
    post: {
      tags,
      security,
      summary: 'Make a stock location the default',
      description: `${access} New products, imports and orders use the default location.`,
      requestParams: { path: idParam },
      responses: { '204': noContent, ...errors(400, 401, 403, 404) },
    },
  },
};
