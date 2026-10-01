/**
 * Preview flattening.
 *
 * The cases that matter are the ones that appear at the START of a model reply,
 * because that is all a one-line preview ever shows: a heading, a bullet, a
 * bold lead-in, a fenced block. The rest is here to pin the two properties that
 * keep this from growing into a parser it should not be — it never drops the
 * words, and it never invents markup.
 */

import { describe, expect, it } from 'vitest';
import { previewText } from './plainText.js';

describe('previewText', () => {
  it('drops heading marks but keeps the heading', () => {
    expect(previewText('## Findings\n\nrest')).toBe('Findings rest');
  });

  it('unwraps emphasis, including the triple form', () => {
    expect(previewText('**bold** and *em* and ***both***')).toBe('bold and em and both');
    expect(previewText('__bold__ and _em_')).toBe('bold and em');
    expect(previewText('~~gone~~')).toBe('gone');
  });

  it('keeps underscores inside words, which Markdown does not treat as emphasis', () => {
    // Seen live: "proposecharacter" and "characterproposal.docx" in Milo's sidebar row.
    expect(previewText('The propose_character tool saved character_proposal.docx')).toBe('The propose_character tool saved character_proposal.docx');
    expect(previewText('_em_ beside snake_case and __bold__.')).toBe('em beside snake_case and bold.');
  });

  it('keeps link text and discards the target', () => {
    expect(previewText('see [the docs](https://example.com/a_b)')).toBe('see the docs');
  });

  it('keeps image alt text without the URL', () => {
    expect(previewText('![a chart](x.png) follows')).toBe('a chart follows');
  });

  it('strips list and quote marks', () => {
    expect(previewText('- one\n- two')).toBe('one two');
    expect(previewText('1. first\n2. second')).toBe('first second');
    expect(previewText('> quoted')).toBe('quoted');
  });

  it('keeps code contents without the fence or the backticks', () => {
    expect(previewText('```js\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(previewText('run `npm test` now')).toBe('run npm test now');
  });

  it('flattens a table into its cells rather than a row of pipes', () => {
    expect(previewText('| Bot | State |\n| --- | --- |\n| Atlas | Idle |')).toBe(
      'Bot State --- --- Atlas Idle'
    );
  });

  it('collapses a horizontal rule to nothing', () => {
    expect(previewText('done\n\n---\n\nnext')).toBe('done next');
  });

  it('leaves plain prose exactly as it is', () => {
    expect(previewText('Just a normal sentence, 2 * 3 = 6.')).toBe(
      'Just a normal sentence, 2 * 3 = 6.'
    );
  });

  it('handles nothing at all', () => {
    expect(previewText(null)).toBe('');
    expect(previewText(undefined)).toBe('');
    expect(previewText('   ')).toBe('');
  });

  it('does not scan an unbounded amount of text for one row of preview', () => {
    // A long reply must not turn a sidebar row into a regex workout.
    const long = 'word '.repeat(5000);
    expect(previewText(long).length).toBeLessThanOrEqual(400);
  });
});
