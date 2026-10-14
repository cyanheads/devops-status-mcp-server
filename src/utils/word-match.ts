/**
 * @fileoverview Word matching for caller-side list filters: text is read as lowercase
 * words — runs of letters and digits — so case and punctuation never decide a match
 * ("git-operations", "Git Operations", and "GIT/operations" all read as `git operations`).
 * @module utils/word-match
 */

/** Anything that is not a letter or digit separates words. */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

/** The lowercase words of `text`, in order; empty when it holds no letter or digit. */
export function toWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(SEPARATORS)
    .filter((word) => word !== '');
}

/**
 * True when every one of `words` appears inside a word of at least one of `texts` —
 * each word independently, so one can come from a title and another from a component
 * name. `words` are expected from {@link toWords}; an empty list matches everything.
 */
export function hasEveryWord(words: readonly string[], texts: readonly string[]): boolean {
  const haystacks = texts.map((text) => toWords(text).join(' '));
  return words.every((word) => haystacks.some((haystack) => haystack.includes(word)));
}
