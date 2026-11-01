import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { env } from '../config/env.ts';

/** Where uploaded files go. S3-compatible storage in the demo and production, a local folder otherwise. */
interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  url(key: string): string;
}

/** Stored files never change (new uploads get new names), so browsers and Cloudflare can cache them for a year. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const LOCAL_UPLOADS_DIR = join(import.meta.dirname, '..', '..', 'uploads');

function localStorage(): Storage {
  const base = (env.MEDIA_PUBLIC_URL ?? `http://localhost:${env.PORT}/uploads`).replace(/\/$/, '');
  return {
    async put(key, body) {
      const path = join(LOCAL_UPLOADS_DIR, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async remove(key) {
      await rm(join(LOCAL_UPLOADS_DIR, key), { force: true });
    },
    url: (key) => `${base}/${key}`,
  };
}

/** Any S3-compatible storage: Neon Object Storage for the demo, S3 (or similar) in production. */
function s3Storage(): Storage {
  const client = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    service: 's3',
    region: env.S3_REGION!,
  });
  const endpoint = new URL(env.S3_ENDPOINT!);
  const bucketUrl = env.S3_FORCE_PATH_STYLE
    ? `${endpoint.origin}/${env.S3_BUCKET}`
    : `${endpoint.protocol}//${env.S3_BUCKET}.${endpoint.host}`;
  const base = (env.MEDIA_PUBLIC_URL ?? bucketUrl).replace(/\/$/, '');

  return {
    async put(key, body, contentType) {
      const res = await client.fetch(`${bucketUrl}/${key}`, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType, 'cache-control': CACHE_CONTROL },
      });
      if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${await res.text()}`);
    },
    async remove(key) {
      const res = await client.fetch(`${bucketUrl}/${key}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status})`);
    },
    url: (key) => `${base}/${key}`,
  };
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? s3Storage() : localStorage();
