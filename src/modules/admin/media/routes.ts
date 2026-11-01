import { Router } from 'express';
import multer from 'multer';
import { ICON_GROUPS, iconLabel } from '../../../lib/catalog-icons.ts';
import { badRequest } from '../../../lib/errors.ts';
import { audit } from '../../../lib/audit.ts';
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_MB } from './schemas.ts';
import { storeImage } from './store.ts';
import { mediaView } from './view.ts';

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

  const row = await storeImage(req.file.buffer, req.file.originalname, req.admin?.id ?? null);

  await audit(req, { action: 'media.upload', entityType: 'media', entityId: row.id, after: row });
  res.status(201).json(mediaView(row));
});

/** The icons categories and brands can use. */
export const iconsRouter = Router();

const iconList = {
  groups: ICON_GROUPS.map((g) => ({ label: g.label, icons: g.icons.map((key) => ({ key, label: iconLabel(key) })) })),
};

iconsRouter.get('/', (_req, res) => {
  res.set('cache-control', 'private, max-age=3600').json(iconList);
});
