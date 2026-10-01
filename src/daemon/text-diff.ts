/**
 * Unified diffs for reviewable repository changes.
 *
 * Line-based Myers diff with bounded work, emitted in the standard `diff --git` unified format so a patch can be
 * reviewed in OpenAgents and applied by ordinary tools. Missing final newlines are marked the standard way.
 */

export interface FileChange { path: string; before: string | null; after: string | null }

const MAX_LINES = 20_000;
const MAX_EDIT_DISTANCE = 4_000;
const NO_EOL = String.fromCharCode(0) + 'no-final-newline';

type Edit = { op: ' ' | '-' | '+'; line: string };

function lines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  else parts[parts.length - 1] += NO_EOL;
  if (parts.length > MAX_LINES) throw new Error(`A changed file exceeds ${MAX_LINES} lines; the patch was not produced.`);
  return parts;
}

/** Myers shortest edit script. Past the edit-distance bound it degrades to a whole-file replacement, which is still correct. */
function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    if (d > MAX_EDIT_DISTANCE) return [...a.map(line => ({ op: '-' as const, line })), ...b.map(line => ({ op: '+' as const, line }))];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  const edits: Edit[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const state = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && state[offset + k - 1] < state[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = state[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { edits.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === previousX) edits.push({ op: '+', line: b[y - 1] });
      else edits.push({ op: '-', line: a[x - 1] });
    }
    x = previousX; y = previousY;
  }
  return edits.reverse();
}

const range = (start: number, count: number) => (count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`);

export function unifiedDiff(changes: FileChange[], context = 3): string {
  const out: string[] = [];
  for (const change of [...changes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    if (change.before === change.after) continue;
    const path = change.path;
    out.push(`diff --git a/${path} b/${path}`);
    if (change.before === null) out.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`);
    else if (change.after === null) out.push('deleted file mode 100644', `--- a/${path}`, '+++ /dev/null');
    else out.push(`--- a/${path}`, `+++ b/${path}`);
    let oldLine = 0, newLine = 0;
    const annotated = diffLines(lines(change.before), lines(change.after)).map(edit => {
      const item = { ...edit, oldLine, newLine };
      if (edit.op !== '+') oldLine++;
      if (edit.op !== '-') newLine++;
      return item;
    });
    const changed = annotated.flatMap((edit, index) => (edit.op === ' ' ? [] : [index]));
    for (let first = 0; first < changed.length;) {
      let last = first;
      while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * context) last++;
      const hunk = annotated.slice(Math.max(0, changed[first] - context), Math.min(annotated.length, changed[last] + context + 1));
      out.push(`@@ -${range(hunk[0].oldLine, hunk.filter(e => e.op !== '+').length)} +${range(hunk[0].newLine, hunk.filter(e => e.op !== '-').length)} @@`);
      for (const edit of hunk) {
        const final = edit.line.endsWith(NO_EOL);
        out.push(edit.op + (final ? edit.line.slice(0, -NO_EOL.length) : edit.line));
        if (final) out.push('\\ No newline at end of file');
      }
      first = last + 1;
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
