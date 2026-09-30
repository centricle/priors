// lines.mjs: how the tally and the site count the lines of a file.
//
// Lines of text: a newline ends a line, so a final newline does not start
// another one, and a last line without a newline still counts. That is
// `wc -l` plus one for an unterminated last line, and 0 for an empty file.
// Splitting on '\n' alone counts the empty field after a final newline as a
// line, which put every newline-terminated output one line above its own
// numbered source view.
//
// Plain JavaScript with no imports, so bin/tally.mjs, the Astro build and
// Node's type stripping (site/scripts/print-stats.mjs) all load the same file.

/**
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
