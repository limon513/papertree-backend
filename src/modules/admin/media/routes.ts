import { Router } from 'express';
import multer from 'multer';
import { db } from '../../../db/client.ts';
import { media } from '../../../db/schema/index.ts';
import { ICON_GROUPS, iconLabel } from '../../../lib/catalog-icons.ts';
import { randomToken } from '../../../lib/crypto.ts';
import { badRequest } from '../../../lib/errors.ts';
import { slugify } from '../../../lib/slug.ts';
import { storage } from '../../../lib/storage.ts';
import { audit } from '../../../lib/audit.ts';
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_MB } from './schemas.ts';
import { processImage } from './process.ts';
import { mediaView, variantKey } from './view.ts';

/** Mounted behind requireAdmin. Any signed-in staff member can upload images. */
export const mediaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return done(null, true);
    done(badRequest('This file type is not allowed', { file: 'Use a JPG, PNG, WebP, AVIF, GIF or SVG image' }));
  },
});

mediaRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose an image to upload', { file: 'Choose an image to upload' });

  const image = await processImage(req.file.buffer);

  // e.g. media/2026/11/x7k2p9q4-faber-logo
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const name = slugify(req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 60) || 'image';
  const keyBase = `media/${now.getUTCFullYear()}/${month}/${randomToken(6).toLowerCase()}-${name}`;

  await Promise.all(
    image.variants.map((v) => storage.put(variantKey(keyBase, v.width), v.body, 'image/webp')),
  );

  const [row] = await db
    .insert(media)
    .values({
      keyBase,
      widths: image.variants.map((v) => v.width),
      width: image.width,
      height: image.height,
      sizeBytes: image.variants.reduce((sum, v) => sum + v.body.length, 0),
      originalName: req.file.originalname.slice(0, 200),
      uploadedBy: req.admin?.id ?? null,
    })
    .returning();

  await audit(req, { action: 'media.upload', entityType: 'media', entityId: row!.id, after: row });
  res.status(201).json(mediaView(row!));
});

/** The icons categories and brands can use. */
export const iconsRouter = Router();

const iconList = {
  groups: ICON_GROUPS.map((g) => ({ label: g.label, icons: g.icons.map((key) => ({ key, label: iconLabel(key) })) })),
};

iconsRouter.get('/', (_req, res) => {
  res.set('cache-control', 'private, max-age=3600').json(iconList);
});
