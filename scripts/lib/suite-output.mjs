/**
 * Read totals out of test-suite output.
 *
 * Suite output arrives with ANSI colour and CRLF, and the two runners report differently:
 * node --test prints "<info> pass N" lines, vitest prints "Tests N passed". Parsing is written
 * without regular-expression escapes on purpose, because an escape that silently degrades turns a
 * real total into "unreadable", and an unreadable total previously looked like a pass.
 */

const ESCAPE = String.fromCharCode(27);
const CARRIAGE_RETURN = String.fromCharCode(13);
const NEWLINE = String.fromCharCode(10);
const OPEN_BRACKET = String.fromCharCode(91);

/** The marker node --test prints before its totals. */
export const NODE_TOTAL = String.fromCharCode(0x2139);
/** The marker node --test prints before a failing test name. */
export const FAILURE_MARK = String.fromCharCode(0x2716);

/** Remove ANSI colour sequences and carriage returns so line matching is exact. */
export function plainText(output) {
  let result = '';
  for (let index = 0; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (code === 13) continue;
    if (code === 27 && output[index + 1] === OPEN_BRACKET) {
      let end = index + 2;
      while (end < output.length && output[end] !== 'm' && output.charCodeAt(end) !== 10) end += 1;
      if (output[end] === 'm') { index = end; continue; }
    }
    result += output[index];
  }
  return result;
}

const digitsAfter = (line, prefix) => {
  if (!line.startsWith(prefix)) return NaN;
  const rest = line.slice(prefix.length).trim();
  return /^[0-9]+$/.test(rest) ? Number(rest) : NaN;
};

/** Totals for either runner, or NaN when the output states none. */
export function counts(text) {
  let pass = NaN, fail = NaN;
  for (const line of text.split(NEWLINE)) {
    const trimmed = line.trimEnd();
    const passed = digitsAfter(trimmed, NODE_TOTAL + ' pass ');
    const failed = digitsAfter(trimmed, NODE_TOTAL + ' fail ');
    if (!Number.isNaN(passed)) pass = passed;
    if (!Number.isNaN(failed)) fail = failed;
  }
  if (!Number.isNaN(pass) || !Number.isNaN(fail)) return { pass, fail };
  const vitest = /Tests[^0-9]+(?:([0-9]+) failed[^0-9]+)?([0-9]+) passed/.exec(text);
  return vitest ? { pass: Number(vitest[2]), fail: Number(vitest[1] ?? 0) } : { pass: NaN, fail: NaN };
}

/** Names of failing tests, without the trailing duration node --test appends. */
export function failureNames(text) {
  const names = [];
  for (const line of text.split(NEWLINE)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FAILURE_MARK + ' ')) continue;
    let name = trimmed.slice(FAILURE_MARK.length + 1);
    const duration = name.lastIndexOf(' (');
    if (duration > 0) name = name.slice(0, duration);
    name = name.trim();
    if (name && name !== 'failing tests:') names.push(name);
  }
  return [...new Set(names)];
}
