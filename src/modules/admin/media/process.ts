import sharp from 'sharp';
import { badRequest } from '../../../lib/errors.ts';

/** Saved widths. Pages pick the smallest one that looks sharp, so they load fast. */
const WIDTHS = [160, 400, 800, 1600];
const MAX_WIDTH = WIDTHS[WIDTHS.length - 1]!;
/** Refuse images over ~40 megapixels: they are almost always a mistake and slow to process. */
const MAX_PIXELS = 40_000_000;

export interface ProcessedImage {
  width: number;
  height: number;
  variants: { width: number; body: Buffer }[];
}

const unreadable = () =>
  badRequest('This file is not an image we can read', {
    file: 'Use a JPG, PNG, WebP, AVIF, GIF or SVG image',
  });

/** Turns an uploaded image into WebP files in several widths (never larger than the original). */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let format: string | undefined;
  let svgWidth: number | undefined;
  try {
    const meta = await sharp(input).metadata();
    format = meta.format;
    svgWidth = meta.width;
  } catch {
    throw unreadable();
  }

  // SVGs (often logos) have no fixed pixel size, so draw them large enough for the biggest width.
  const density = format === 'svg' && svgWidth ? Math.min(2400, Math.max(72, Math.ceil((72 * MAX_WIDTH) / svgWidth))) : undefined;
  const open = () => sharp(input, { density, animated: false, limitInputPixels: MAX_PIXELS }).autoOrient();

  let fullWidth: number;
  try {
    const meta = await open().metadata();
    fullWidth = meta.autoOrient?.width ?? meta.width;
  } catch (err) {
    if (err instanceof Error && /pixel limit/i.test(err.message)) {
      throw badRequest('This image is too large', { file: 'Use an image under 40 megapixels' });
    }
    throw unreadable();
  }
  if (fullWidth < 32) throw badRequest('This image is too small', { file: 'Use an image at least 32 pixels wide' });

  const widths = [...WIDTHS.filter((w) => w < fullWidth), Math.min(fullWidth, MAX_WIDTH)];
  const variants = await Promise.all(
    widths.map(async (width) => {
      const { data, info } = await open()
        .resize({ width })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      return { width, height: info.height, body: data };
    }),
  );

  const largest = variants[variants.length - 1]!;
  return { width: largest.width, height: largest.height, variants };
}
