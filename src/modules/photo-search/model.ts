import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { env } from '../../config/env.ts';
import { serviceUnavailable } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';

/**
 * The image model for search by photo: Google's SigLIP (base, 224 px), run on this server with ONNX
 * (no paid service, nothing sent elsewhere). It turns a picture into 768 numbers; pictures that look
 * alike get close numbers. Chosen after testing on the shop's own pictures: it finds a product from a
 * tilted, dim or blurry photo almost always, far better than CLIP.
 *
 * The model files (about 100 MB) are downloaded from Hugging Face the first time and kept in models/.
 * It is loaded on first use (adds about 250 MB of memory) and let go after a quiet while.
 */
export const IMAGE_MODEL = 'Xenova/siglip-base-patch16-224';
/** Compressed to 8-bit numbers: a quarter of the size, the same results in our tests. */
const DTYPE = 'q8';
const SIZE = 224;
/** Let go of the model after this long without use (frees memory on small servers). */
const IDLE_MS = 20 * 60_000;
/** Photos waiting for the model at once; more than this and the shopper is asked to try again. */
const MAX_WAITING = 8;

type Vision = {
  processor: (images: unknown) => Promise<Record<string, unknown>>;
  model: ((inputs: Record<string, unknown>) => Promise<{ pooler_output: { data: Float32Array } }>) & { dispose: () => Promise<unknown> };
  RawImage: new (data: Uint8ClampedArray, width: number, height: number, channels: number) => unknown;
};

let loading: Promise<Vision> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function load(): Promise<Vision> {
  const started = Date.now();
  const hf = await import('@huggingface/transformers');
  hf.env.cacheDir = join(import.meta.dirname, '..', '..', '..', 'models');
  const [processor, model] = await Promise.all([
    hf.AutoProcessor.from_pretrained(IMAGE_MODEL),
    hf.SiglipVisionModel.from_pretrained(IMAGE_MODEL, { dtype: DTYPE }),
  ]);
  logger.info({ ms: Date.now() - started }, 'Photo search model loaded');
  return { processor: processor as unknown as Vision['processor'], model: model as unknown as Vision['model'], RawImage: hf.RawImage as unknown as Vision['RawImage'] };
}

function vision() {
  loading ??= load().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

function restartIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const was = loading;
    loading = null;
    void was?.then((v) => v.model.dispose()).catch(() => {});
    logger.info('Photo search model let go (not used for a while)');
  }, IDLE_MS);
  idleTimer.unref();
}

// One picture at a time through the model (it already uses every CPU core for one picture).
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING) throw serviceUnavailable('Photo search is busy right now. Please try again in a moment.');
  waiting++;
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run.finally(() => {
    waiting--;
    restartIdleTimer();
  });
}

const unit = (v: Float32Array) => {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / s);
};

/**
 * The numbers for one picture. The picture is fitted whole into a white square first (nothing cut
 * off or squashed), the same way for product pictures and shoppers' photos.
 */
export async function embed(picture: Buffer | Sharp): Promise<number[]> {
  if (!env.PHOTO_SEARCH) throw serviceUnavailable('Search by photo is switched off');
  const s = Buffer.isBuffer(picture) ? sharp(picture, { limitInputPixels: 50_000_000 }) : picture;
  const { data } = await s
    .flatten({ background: '#ffffff' })
    .resize(SIZE, SIZE, { fit: 'contain', background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return inTurn(async () => {
    const v = await vision();
    const image = new v.RawImage(new Uint8ClampedArray(data), SIZE, SIZE, 3);
    const out = await v.model(await v.processor(image));
    return unit(out.pooler_output.data);
  });
}

/** pgvector's text form of the numbers. */
export const asVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;
