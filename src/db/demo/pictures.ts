import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Placeholder pictures for the sample shop: a soft background, the category icon and the name.
 * Real photos replace them later.
 */

const ICONS_DIR = join(import.meta.dirname, '..', '..', '..', 'public', 'icons');

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Splits text into lines of about `width` characters, at most `max` lines. */
function wrap(text: string, width: number, max: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    lines.length = max;
    lines[max - 1] = lines[max - 1]!.replace(/\s*\S*$/, '…');
  }
  return lines;
}

async function iconBody(key: string) {
  const svg = await readFile(join(ICONS_DIR, `${key}.svg`), 'utf8');
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

/**
 * A 1200×1200 product picture. `hue` is 0–360. `caption` adds a small label at the top ("Back",
 * "Red"), so a product's extra pictures and its colours look different from each other.
 */
export async function productPicture(name: string, icon: string, hue: number, caption?: string) {
  const lines = wrap(name, 26, 3);
  const label = caption
    ? `<rect x="420" y="70" width="360" height="84" rx="42" fill="hsl(${hue} 45% 30%)"/>
  <text x="600" y="126" text-anchor="middle" font-family="Segoe UI, Inter, Arial, sans-serif" font-size="44" font-weight="600" fill="#ffffff">${escapeXml(caption)}</text>`
    : '';
  const text = lines
    .map((l, i) => `<tspan x="600" dy="${i === 0 ? 0 : 64}">${escapeXml(l)}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 96%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 88%)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="1200" fill="url(#bg)"/>
  <circle cx="600" cy="500" r="290" fill="#ffffff" fill-opacity="0.75"/>
  <svg x="390" y="290" width="420" height="420" viewBox="0 0 32 32">${await iconBody(icon)}</svg>
  ${label}
  <text x="600" y="${930 - (lines.length - 1) * 32}" text-anchor="middle" font-family="Segoe UI, Inter, Arial, sans-serif"
    font-size="54" font-weight="600" fill="hsl(${hue} 35% 22%)">${text}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** An 800×400 brand name card on a transparent background. */
export async function brandPicture(name: string, color: string) {
  const size = name.length > 12 ? 92 : 120;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">
  <rect x="20" y="60" width="760" height="280" rx="48" fill="${color}"/>
  <text x="400" y="${200 + size * 0.35}" text-anchor="middle" font-family="Segoe UI, Inter, Arial, sans-serif"
    font-size="${size}" font-weight="700" fill="#ffffff">${escapeXml(name)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
