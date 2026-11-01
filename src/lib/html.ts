import sanitizeHtml from 'sanitize-html';

/**
 * Cleans rich text (product descriptions) before saving: keeps formatting, tables, links and
 * images, removes scripts, styles and anything else that could break or attack the website.
 */
export function cleanHtml(html: string) {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'code',
      'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
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
