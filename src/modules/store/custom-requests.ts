import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import multer from 'multer';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { CUSTOM_KINDS, customRequestFiles, customRequests } from '../../db/schema/index.ts';
import { badRequest, notFound, unauthorized } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { bdPhone } from '../../lib/phone.ts';
import { storage } from '../../lib/storage.ts';
import { getIntegration, sendEmail } from '../admin/integrations/service.ts';
import { emailSchema, nameSchema } from '../admin/schemas.ts';
import { currentCustomer, CUSTOMER_COOKIE } from './account/session.ts';
import { esc } from './order-emails.ts';

/**
 * "Custom order" on the website: a customer describes something to be made, and staff call back with a
 * priced quotation. Artwork (images or PDF) only from signed-in customers. Mounted at /v1/store/custom-requests.
 */
export const customRequestsRouter = Router();

export const MAX_FILES = 3;
const MAX_FILE_MB = 5;
export const requestNumber = (n: number) => `CR-${n}`;

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'You have sent several requests already. Please call or WhatsApp us instead.' } },
});
const fileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.cookies?.[CUSTOMER_COOKIE] as string | undefined) ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'TOO_MANY', message: 'Too many files. Please send the rest on WhatsApp.' } },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 } });

/** What a file really is, from its first bytes (never trusting its name or the browser): JPG, PNG, WebP or PDF. */
function kindOf(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.length > 5 && b.toString('ascii', 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  return null;
}

async function signedIn(req: Request) {
  const c = await currentCustomer(req);
  if (!c) throw unauthorized('Please sign in to attach files');
  return c;
}

/** A file for a custom request (signed in). Kept under a long random name; staff see it with the request. */
customRequestsRouter.post('/files', fileLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(badRequest(`Files up to ${MAX_FILE_MB} MB`, { file: `Files up to ${MAX_FILE_MB} MB` }));
    next(err);
  });
}, async (req, res) => {
  const c = await signedIn(req);
  if (!req.file) throw badRequest('Choose a file', { file: 'Choose a file' });
  const kind = kindOf(req.file.buffer);
  if (!kind) throw badRequest('Use a JPG, PNG, WebP picture or a PDF', { file: 'Use a JPG, PNG, WebP picture or a PDF' });
  // Not too many files waiting to be sent from one account (each request takes at most 3).
  const [waiting] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(customRequestFiles)
    .where(and(eq(customRequestFiles.customerId, c.id), isNull(customRequestFiles.requestId), gte(customRequestFiles.createdAt, new Date(Date.now() - 86_400_000))));
  if ((waiting?.n ?? 0) >= 12) throw badRequest('Too many files waiting. Send your request first.', { file: 'Too many files waiting' });
  const key = `custom/${new Date().toISOString().slice(0, 7)}/${randomBytes(24).toString('hex')}.${kind.ext}`;
  await storage.put(key, req.file.buffer, kind.type);
  const name = (req.file.originalname || `artwork.${kind.ext}`).replace(/[^\w .()-]/g, '_').slice(0, 120);
  const [row] = await db
    .insert(customRequestFiles)
    .values({ customerId: c.id, storageKey: key, fileName: name, contentType: kind.type, size: req.file.size })
    .returning({ id: customRequestFiles.id, fileName: customRequestFiles.fileName, size: customRequestFiles.size, contentType: customRequestFiles.contentType });
  res.status(201).json(row);
});

/** Take back a file not sent yet. */
customRequestsRouter.delete('/files/:id', fileLimiter, async (req, res) => {
  const c = await signedIn(req);
  const id = Number(req.params.id);
  const [row] = await db
    .delete(customRequestFiles)
    .where(and(eq(customRequestFiles.id, Number.isInteger(id) ? id : 0), eq(customRequestFiles.customerId, c.id), isNull(customRequestFiles.requestId)))
    .returning({ key: customRequestFiles.storageKey });
  if (!row) throw notFound('File not found');
  await storage.remove(row.key).catch((err) => logger.warn({ err }, 'Could not remove a custom request file'));
  res.status(204).end();
});

const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().default(null);
export const customRequestBody = z
  .object({
    kind: z.enum(CUSTOM_KINDS, { error: 'Choose what to make' }),
    specs: z
      .array(z.object({ label: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(300) }))
      .max(20)
      .default([]),
    quantity: z.number({ error: 'Enter how many' }).int({ error: 'Whole pieces only' }).min(1, { error: 'At least 1' }).max(1_000_000, { error: 'Too many' }),
    notes: text(2000),
    name: nameSchema,
    phone: bdPhone,
    email: emailSchema.nullable().or(z.literal('').transform(() => null)).default(null),
    city: text(100),
    fileIds: z.array(z.number().int().positive()).max(MAX_FILES, { error: `At most ${MAX_FILES} files` }).default([]),
    /** Left empty by people; bots fill every box. */
    website: z.string().max(200).optional(),
  })
  .meta({ id: 'StoreCustomRequestBody' });

/** Send a custom order request. Files must be the shopper's own, not sent with another request. */
customRequestsRouter.post('/', sendLimiter, async (req, res) => {
  const { website, fileIds, ...input } = customRequestBody.parse(req.body);
  if (website) {
    res.status(201).json({ number: null });
    return;
  }
  const me = await currentCustomer(req);
  if (fileIds.length && !me) throw unauthorized('Please sign in to attach files');
  const ids = [...new Set(fileIds)];
  const r = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(customRequests)
      .values({ ...input, customerId: me?.id ?? null })
      .returning({ id: customRequests.id, number: customRequests.number });
    if (ids.length) {
      const attached = await tx
        .update(customRequestFiles)
        .set({ requestId: row!.id })
        .where(and(inArray(customRequestFiles.id, ids), eq(customRequestFiles.customerId, me!.id), isNull(customRequestFiles.requestId)))
        .returning({ id: customRequestFiles.id });
      if (attached.length !== ids.length) throw badRequest('A file is missing. Please attach it again.', { fileIds: 'Attach the file again' });
    }
    return row!;
  });
  res.status(201).json({ number: requestNumber(r.number) });
  // Staff are told by email (Integrations → Email → staff address); never in the shopper's way.
  void customRequestAlert(r.id, r.number, input, ids.length);
});

const KIND_NAMES: Record<string, string> = {
  notebook: 'Custom notebook',
  canvas: 'Custom canvas',
  pen: 'Custom printed pen',
  paper: 'Custom paper & card',
  sketchbook: 'Custom sketchbook',
  sticker: 'Custom labels & stickers',
  folder: 'Custom office folder',
  other: 'Other custom product',
};
export const kindName = (kind: string) => KIND_NAMES[kind] ?? kind;

async function customRequestAlert(id: number, number: number, r: Omit<z.infer<typeof customRequestBody>, 'fileIds' | 'website'>, files: number) {
  try {
    const { settings } = await getIntegration('email');
    if (!settings.staffEmail) return;
    const rows: [string, string][] = [
      ['What', kindName(r.kind)],
      ...r.specs.map((s) => [s.label, s.value] as [string, string]),
      ['Quantity', String(r.quantity)],
      ...(r.notes ? [['Notes', r.notes] as [string, string]] : []),
      ['Name', r.name],
      ['Phone', r.phone],
      ...(r.email ? [['Email', r.email] as [string, string]] : []),
      ...(r.city ? [['City', r.city] as [string, string]] : []),
      ...(files ? [['Artwork', `${files} file${files === 1 ? '' : 's'}`] as [string, string]] : []),
    ];
    const admin = `${env.ADMIN_APP_URL.replace(/\/$/, '')}/leads?tab=custom`;
    const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#18181b;background:#f4f4f5;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
<h1 style="margin:0 0 12px;font-size:20px">New custom order request ${requestNumber(number)}</h1>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${rows
      .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#71717a;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
      .join('')}</table>
<p style="margin:20px 0 0"><a href="${esc(admin)}" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">Open in the admin</a></p>
</div></body></html>`;
    const textBody = [`New custom order request ${requestNumber(number)}`, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', admin].join('\n');
    await sendEmail({ to: settings.staffEmail, subject: `Custom order ${requestNumber(number)}: ${kindName(r.kind)} × ${r.quantity}`, html, text: textBody, purpose: `custom.request #${id}` });
  } catch (err) {
    logger.warn({ err }, 'Could not send the custom request alert');
  }
}
