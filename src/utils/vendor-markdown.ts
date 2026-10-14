/**
 * @fileoverview Markdown rendering of vendor-authored text for `format()`. Status pages
 * write incident names, component names, and update bodies that this server relays, so
 * `content[]` marks them as data: an inline value cannot start a new line, a body sits
 * inside a blockquote, and neither can carry markup a renderer would act on.
 * `structuredContent` keeps the same strings unescaped.
 * @module utils/vendor-markdown
 */

/**
 * `<` always, and `&` only where it begins a character reference a CommonMark renderer
 * would decode — a bare `&` ("Debugger & Alarms") renders as itself and stays readable.
 */
function escapeMarkup(text: string): string {
  return text
    .replace(/&(?=#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,31};)/g, '&amp;')
    .replaceAll('<', '&lt;');
}

/** Vendor text interpolated into a line: line breaks flattened to a space, then escaped. */
export function vendorInline(text: string): string {
  return escapeMarkup(text.replace(/[\r\n]+/g, ' '));
}

/**
 * Vendor text as a blockquote indented two spaces, so it nests under the list item or
 * line above it. Every line carries the `>`, so a heading, list marker, or fence in the
 * text stays inside the quote. Empty text renders no lines.
 */
export function vendorQuote(text: string): string[] {
  if (text === '') return [];
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line === '' ? '  >' : `  > ${escapeMarkup(line)}`));
}
