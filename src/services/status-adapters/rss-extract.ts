/**
 * @fileoverview Narrow RSS 2.0 extractor shared by the adapters that read a status RSS
 * feed. It reads the `<item>` elements of a feed's `<channel>` and the character data of
 * named child elements, namespaced ones (`content:encoded`) included.
 *
 * Parsing is a narrow extractor rather than an XML library. The status feeds escape item
 * text as entities and carry few attributes; a general parser returns a lone item as a
 * scalar, coerces a numeric-looking `guid`, and still leaves the escaped HTML to decode by
 * hand. The extractor still reads the other forms RSS 2.0 allows — CDATA sections,
 * comments, attributes, self-closing elements, whitespace inside end tags — rather than
 * misreading them as text or markup. Every scan is linear in the body.
 * @module services/status-adapters/rss-extract
 */

import { decodeCharacterReferences, XML_REFERENCES } from '@/utils/html-to-text.js';

const escapeText = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Drop comments and rewrite each CDATA section as the same text escaped, so the element
 * scan below sees only elements and character references. Whichever opens first wins, as
 * in XML itself: a comment inside a CDATA section is text, and a CDATA section inside a
 * comment is gone. Each terminator is found with indexOf, so the work stays linear; an
 * unterminated one runs to the end of the body, which leaves the document malformed.
 */
function flattenMarkup(xml: string): string {
  const opener = /<!--|<!\[CDATA\[/g;
  let out = '';
  let from = 0;
  for (let m = opener.exec(xml); m; m = opener.exec(xml)) {
    const comment = m[0] === '<!--';
    const start = m.index + m[0].length;
    const end = xml.indexOf(comment ? '-->' : ']]>', start);
    out += xml.slice(from, m.index);
    if (end === -1) return out;
    if (!comment) out += escapeText(xml.slice(start, end));
    from = end + 3;
    opener.lastIndex = from;
  }
  return out + xml.slice(from);
}

/**
 * Raw inner markup of every `<tag …>…</tag>` in `xml`, in order. Open tags may carry
 * attributes; a self-closing `<tag/>` has no body and is skipped. Each close is found
 * by a forward search and the scan resumes past it, so the work stays linear in the
 * body — an element with no close ends the scan, since no later one could close either.
 */
function elementBodies(xml: string, tag: string): string[] {
  const open = new RegExp(`<${tag}(?:\\s[^<>]*)?(?<!/)>`, 'g');
  const close = new RegExp(`</${tag}\\s*>`, 'g');
  const bodies: string[] = [];
  while (open.exec(xml)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (end === null) break;
    bodies.push(xml.slice(open.lastIndex, end.index));
    open.lastIndex = close.lastIndex;
  }
  return bodies;
}

/**
 * The raw markup of each `<item>` in the body's RSS `<channel>`, in feed order, with
 * comments dropped and CDATA sections escaped. Undefined when the body has no channel —
 * some other document, which a caller rejects rather than reads as an empty feed.
 */
export function rssItems(xml: string): string[] | undefined {
  const channel = elementBodies(flattenMarkup(xml), 'channel')[0];
  return channel === undefined ? undefined : elementBodies(channel, 'item');
}

/** Character data of every `<tag>` element in `item`, its character references decoded. */
export function elementTexts(item: string, tag: string): string[] {
  return elementBodies(item, tag).map((body) => decodeCharacterReferences(body, XML_REFERENCES));
}

/** Character data of the first `<tag>` element in `item`, or '' when it has none. */
export function elementText(item: string, tag: string): string {
  return elementTexts(item, tag)[0] ?? '';
}
