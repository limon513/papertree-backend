/**
 * Writes public/icons/{key}.svg for every icon in src/lib/catalog-icons.ts,
 * taken from the Fluent Emoji Flat set (MIT licence, Microsoft).
 * Run with: npm run icons:build
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ICON_KEYS } from '../src/lib/catalog-icons.ts';

interface IconSet {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number; left?: number; top?: number }>;
  aliases?: Record<string, { parent: string }>;
}

const require = createRequire(import.meta.url);
const setPath = require.resolve('@iconify-json/fluent-emoji-flat/icons.json');
const set = JSON.parse(await readFile(setPath, 'utf8')) as IconSet;

const outDir = join(import.meta.dirname, '..', 'public', 'icons');
await mkdir(outDir, { recursive: true });

// Remove icons that are no longer in the list.
for (const file of await readdir(outDir)) {
  if (file.endsWith('.svg') && !ICON_KEYS.includes(file.slice(0, -4))) await rm(join(outDir, file));
}

const missing: string[] = [];
for (const key of ICON_KEYS) {
  const icon = set.icons[key] ?? set.icons[set.aliases?.[key]?.parent ?? ''];
  if (!icon) {
    missing.push(key);
    continue;
  }
  const width = icon.width ?? set.width ?? 32;
  const height = icon.height ?? set.height ?? 32;
  const viewBox = `${icon.left ?? 0} ${icon.top ?? 0} ${width} ${height}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${icon.body}</svg>\n`;
  await writeFile(join(outDir, `${key}.svg`), svg);
}

await writeFile(
  join(outDir, 'LICENSE.txt'),
  'Icons from Fluent Emoji (https://github.com/microsoft/fluentui-emoji)\n' +
    'Copyright (c) Microsoft Corporation. Licensed under the MIT License.\n',
);

if (missing.length) {
  console.error(`Not found in the icon set: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`Wrote ${ICON_KEYS.length} icons to public/icons`);
