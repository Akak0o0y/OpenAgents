/**
 * Markdown source, flattened to a line of prose.
 *
 * A sidebar preview is one line of plain text in a fixed-width row. The
 * transcript renders Markdown, but a preview cannot - so without this the row
 * shows `**Summary**` and `###` and the reader sees the syntax rather than the
 * message.
 *
 * This is NOT a Markdown parser and must not become one. It strips the marks
 * that show up at the start of a reply and would otherwise be the first thing
 * in the row; anything it misses degrades to the raw character, which is the
 * behaviour it already had. Nothing here reaches the DOM as HTML.
 */

/** Longest input worth scanning. A preview only ever shows the first line. */
const SCAN_LIMIT = 400;

export function previewText(source: string | null | undefined): string {
  if (!source) return '';

  let text = source.slice(0, SCAN_LIMIT);

  text = text
    // Fenced code: keep the code, drop the fence and its language tag.
    .replace(/```[a-zA-Z0-9]*\n?/g, ' ')
    // Images before links, so the alt text of an image is not kept as a label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Leading block marks: heading hashes, quote carets, list bullets.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    // A horizontal rule carries no words at all.
    .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, ' ')
    // Emphasis and inline code, innermost first so ***x*** unwraps fully. Underscores
    // inside a word are not emphasis in Markdown: propose_character stays whole.
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/(?<!\w)___(.+?)___(?!\w)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Table pipes would otherwise dominate a row of cells.
    .replace(/\|/g, ' ');

  // One line, single-spaced: the row cannot show a second one anyway.
  return text.replace(/\s+/g, ' ').trim();
}
