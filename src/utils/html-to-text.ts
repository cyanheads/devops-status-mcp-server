/**
 * @fileoverview Plain-text rendering of the HTML that vendors write into status update
 * bodies. Every status backend normalizes its bodies through `htmlToText` once, where
 * raw vendor text enters the shared incident shape.
 *
 * Only a tag named for an HTML element counts as markup. Status bodies also carry `<`
 * as ordinary text — "(<1%)", "<30min", template placeholders such as
 * `<FUNCTIONALITY IMPACTED>`, autolinks such as `<https://…>` — and all of it stays.
 * Removing one of those would change what the vendor said; a stray `<` left in the
 * text is made safe where it is rendered, by `format()` escaping, not here.
 * @module utils/html-to-text
 */

/** The WHATWG HTML "List of elements" (html.spec.whatwg.org/multipage/indices.html). */
const HTML_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'selectedcontent',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/** Elements whose end tag ends a line of text. */
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
]);

/** XML's five named references — a Map, so `&constructor;` cannot resolve through a prototype. */
export const XML_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** HTML adds `nbsp`, the only named reference beyond XML's five seen in vendor bodies. */
const HTML_REFERENCES: ReadonlyMap<string, string> = new Map([...XML_REFERENCES, ['nbsp', ' ']]);

/** The text one character reference (`ref` is what sits between `&` and `;`) stands for. */
function decodeReference(match: string, ref: string, named: ReadonlyMap<string, string>): string {
  if (ref[0] === '#') {
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  }
  return named.get(ref.toLowerCase()) ?? match;
}

/**
 * Decode named and numeric character references in one pass, so an escaped
 * reference (`&amp;lt;`) decodes once, to `&lt;`, never on to `<`. A name `named`
 * does not carry stays the text it is.
 */
export function decodeCharacterReferences(
  text: string,
  named: ReadonlyMap<string, string>,
): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) =>
    decodeReference(match, ref, named),
  );
}

/** Collapse whitespace within each line and drop the blank lines left by removed markup. */
function tidyLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

const isAsciiLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number) => c >= 0x30 && c <= 0x39;
/** HTML's ASCII whitespace: tab, LF, FF, CR, space. */
const isHtmlSpace = (c: number) =>
  c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;

interface Tag {
  attributes: string;
  closing: boolean;
  /** Index just past the tag's `>`. */
  end: number;
  /** Lowercased element name. */
  name: string;
}

/**
 * Read the tag that opens at `html[start] === '<'`, or null when no HTML element tag
 * starts there. A tag is `<name>`, `</name>`, or the name followed by whitespace or `/`
 * and an attribute run that holds no `<` before its `>`. The scan never passes the
 * next `<`, so a run of unterminated tags is read in one pass over the text.
 */
function readElementTag(html: string, start: number): Tag | null {
  let i = start + 1;
  const closing = html.charCodeAt(i) === 0x2f; // '/'
  if (closing) i++;
  const nameStart = i;
  if (!isAsciiLetter(html.charCodeAt(i))) return null;
  while (isAsciiLetter(html.charCodeAt(i)) || isAsciiDigit(html.charCodeAt(i))) i++;
  const name = html.slice(nameStart, i).toLowerCase();
  if (!HTML_ELEMENTS.has(name)) return null;

  const next = html.charCodeAt(i);
  if (next === 0x3e) return { name, closing, attributes: '', end: i + 1 }; // '>'
  if (next !== 0x2f && !isHtmlSpace(next)) return null;
  let j = i;
  while (j < html.length) {
    const c = html.charCodeAt(j);
    if (c === 0x3e) return { name, closing, attributes: html.slice(i, j), end: j + 1 };
    if (c === 0x3c) return null; // '<'
    j++;
  }
  return null;
}

/** An `href` attribute whose value is double-quoted, single-quoted, or bare. */
const HREF = /(?:^|[\s/])href[ \t\n\f\r]*=[ \t\n\f\r]*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** The `href` of an anchor's attribute run, its character references decoded. */
function hrefOf(attributes: string): string | undefined {
  const match = HREF.exec(attributes);
  if (!match) return;
  return decodeCharacterReferences(match[1] ?? match[2] ?? match[3] ?? '', HTML_REFERENCES);
}

/**
 * A link as its text, then its URL — the URL alone when the two match or the text is
 * empty. Whitespace around the text stays outside the rendering, between its neighbors.
 */
function renderLink(label: string, href: string): string {
  const shown = label.trim();
  const before = label.slice(0, label.length - label.trimStart().length);
  const after = label.slice(label.trimEnd().length);
  const rendered =
    shown.replace(/\/$/, '') === href.replace(/\/$/, '') || shown === ''
      ? href
      : `${shown} (${href})`;
  return `${before}${rendered}${after}`;
}

/**
 * Render an update body's HTML as plain text: paragraphs, block ends, and `<br>` as
 * line breaks, list items as `- ` lines, a link as its text with the URL after it (an
 * anchor left open runs to the next anchor or the end of the body), comments and every
 * other element tag dropped, and character references decoded once.
 * Any `<` that does not open an element tag or a closed comment is text and stays.
 *
 * A body with no element tag, comment, or decodable character reference is returned
 * unchanged — plain-text and markdown bodies keep their blank lines and indentation.
 * The work is one forward pass, linear in the body.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let changed = false;
  /** The open `<a href>` whose label is being collected: its href and first label chunk. */
  let link: { href: string; start: number } | null = null;
  /** Set once a search for `-->` fails — no later comment can close either. */
  let commentsUnclosed = false;

  const pushText = (text: string) => {
    const decoded = decodeCharacterReferences(text, HTML_REFERENCES);
    if (decoded !== text) changed = true;
    out.push(decoded);
  };
  const closeLink = () => {
    if (link !== null) out.push(renderLink(out.splice(link.start).join(''), link.href));
    link = null;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt) && !commentsUnclosed) {
      const close = html.indexOf('-->', lt + 4);
      if (close !== -1) {
        changed = true;
        i = close + 3;
        continue;
      }
      commentsUnclosed = true;
    }

    const tag = readElementTag(html, lt);
    if (tag === null) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    changed = true;
    i = tag.end;

    if (tag.name === 'a') {
      // As in an HTML parser, an anchor that opens while another is open ends that one.
      closeLink();
      const href = tag.closing ? undefined : hrefOf(tag.attributes);
      if (href !== undefined) link = { href, start: out.length };
    } else if (tag.name === 'br' || (tag.name === 'hr' && !tag.closing)) {
      out.push('\n');
    } else if (tag.name === 'li' && !tag.closing) {
      out.push('\n- ');
    } else if (tag.closing && BLOCK_ELEMENTS.has(tag.name)) {
      out.push('\n');
    }
  }

  // An anchor never closed runs to the end of the body, as it does on the vendor's page.
  closeLink();
  return changed ? tidyLines(out.join('')) : html;
}
