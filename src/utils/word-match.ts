/**
 * @fileoverview Word matching for caller-side list filters: text is read as lowercase
 * words — runs of letters and digits — so case and punctuation never decide which words
 * it holds ("git-operations", "Git Operations", and "GIT/operations" all read as
 * `git operations`). A filter is read as terms split on whitespace, each matched on its
 * own, so different terms can come from different texts. A one-word term matches inside
 * any word of any text. A term whose words are joined by punctuation ("eu-central-1",
 * "GIT/operations") matches only where its words appear in order and adjacent within one
 * text, the first still matching the end of a word and the last its start: "south-1"
 * matches `me-south-1`, while "eu-central-1" matches neither `me-central-1` nor a
 * "Prometheus" in one text beside `central-1` in another.
 * @module utils/word-match
 */

/** Anything that is not a letter or digit separates words. */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

/** Whitespace separates terms; punctuation inside a term joins its words. */
const WHITESPACE = /\s+/u;

/** The lowercase words of `text`, in order; empty when it holds no letter or digit. */
export function toWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(SEPARATORS)
    .filter((word) => word !== '');
}

/**
 * `text` as its words joined by hyphens. A hyphen never occurs inside a word, so a term
 * read this way is found in a text read this way only where its words sit adjacent.
 */
function hyphenated(text: string): string {
  return toWords(text).join('-');
}

/**
 * The whitespace-separated terms of `text`, each read as its lowercase words joined by
 * hyphens (`"EU/Central-1 Pull"` → `["eu-central-1", "pull"]`), which is also how a term
 * reads back to a caller. A term with no letter or digit is dropped, so text with none
 * yields no terms.
 */
export function toTerms(text: string): string[] {
  return text
    .split(WHITESPACE)
    .map(hyphenated)
    .filter((term) => term !== '');
}

/**
 * True when every one of `terms` appears in at least one of `texts` — each term
 * independently, so one can come from a title and another from a component name. A
 * term's words must appear in order and adjacent within that one text; its first word may
 * end a longer word and its last may begin one, so a one-word term matches inside any
 * word. `terms` are expected from {@link toTerms}; an empty list matches everything. At
 * worst the scan grows with the texts' length times a term's length, so callers bound the
 * terms they pass.
 */
export function hasEveryTerm(terms: readonly string[], texts: readonly string[]): boolean {
  const haystacks = texts.map(hyphenated);
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
}
