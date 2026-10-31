/**
 * @fileoverview Markdown rendering of strings read off a probed host — certificate names,
 * DNS record values, the caller's own entry — for `format()`. `structuredContent` keeps the
 * same strings as read.
 * @module utils/markdown-literal
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * A string the tool did not author as one code span a CommonMark parse reads back as
 * written, so no backslash is added to a value an agent copies. Line breaks flatten to one
 * space first: a span reads them back as spaces anyway, and a heading or list item would end
 * at one. An empty value renders as `(empty)`, since two backticks are not a span.
 */
export function literal(value: string): string {
  if (value === '') return '(empty)';
  return markdown()
    .inlineCode(value.replace(/[\r\n]+/g, ' '))
    .build();
}
