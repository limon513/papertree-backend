import sanitizeHtml from 'sanitize-html';

/**
 * Cleans rich text (product descriptions) before saving: keeps formatting, tables, links and
 * images, removes scripts, styles and anything else that could break or attack the website.
 * With `copied: true` (text from other websites) pictures and empty paragraphs are removed too.
 */
export function cleanHtml(html: string, { copied = false }: { copied?: boolean } = {}) {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'code',
      'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      ...(copied ? [] : ['img']),
    ],
    // Other shops leave many empty paragraphs and headings that show as big gaps.
    exclusiveFilter: copied ? (frame) => /^(p|h[1-6]|strong|b|em|i|u)$/.test(frame.tag) && !frame.text.trim() : undefined,
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https'] },
    transformTags: {
      // Old headings from imports: h1 is the product name on the page, so demote to h2.
      h1: 'h2',
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', ...(attribs.target ? { target: '_blank' } : {}) },
      }),
    },
  }).trim();
  // The editor sends <p></p> for an empty document.
  return cleaned === '' || cleaned === '<p></p>' ? null : cleaned;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** "Pens &amp; Pencils &#8211; A4" -> "Pens & Pencils – A4". */
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Plain text from HTML: list items on their own lines, tags removed, spaces tidied. */
export function htmlToText(html: string) {
  const withBreaks = html.replace(/<\/(p|li|h[1-6]|div|tr)>|<br\s*\/?>/gi, '\n');
  return decodeEntities(sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} }))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
