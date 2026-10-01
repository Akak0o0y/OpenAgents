/**
 * Vendor UI elements from Uiverse.io.
 *
 * Uiverse publishes every approved element to github.com/uiverse-io/galaxy
 * under the MIT licence, as a standalone HTML file with a `<style>` block. This
 * script pulls the ones named below and writes them into
 * `src/registry/uiverse/`, the same way `vendor-coss.mjs` handles Coss - so the
 * provenance of every line is a URL and a commit rather than a paste.
 *
 * THE ONE MODIFICATION, and it is not optional: the source styles elements by
 * TAG. `figure { ... }`, `button { ... }`, `.loader` - written for a standalone
 * page where nothing else exists. Dropped into this app as-is, a loader would
 * restyle every `<figure>` on the screen. So each rule is prefixed with the
 * element's own scope class and its keyframes are renamed, both mechanically.
 * Nothing else is touched: the geometry, the timings and the animation are the
 * author's work and are left exactly as written.
 *
 * MIT requires the copyright notice to travel with the code. Each file keeps
 * the author's credit comment, and THIRD_PARTY_NOTICES.md records the licence.
 *
 *   node scripts/vendor-uiverse.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/uiverse-io/galaxy/main';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'registry', 'uiverse');

/**
 * The curated set, and why each one is here.
 *
 * Uiverse has over three thousand elements and most are built for a different
 * kind of interface than this one - neon, saturated, heavy gradients. These
 * were picked on one criterion: the shape and the motion carry the idea, so
 * they still read when the colour comes from this app's tokens.
 */
const ELEMENTS = [
  { slug: 'orbit-loader', from: 'loaders/VashonG_spicy-crab-68.html',
    note: 'Twelve diamonds on a rotating ring. Colour is one HSL pair, so it themes cleanly.' },
  { slug: 'pulse-loader', from: 'loaders/Shoh2008_ugly-elephant-80.html',
    note: 'A small two-tone pulse, for inline waiting.' },
  { slug: 'ring-loader', from: 'loaders/Shoh2008_lucky-quail-40.html',
    note: 'A single rotating ring at text size.' },
];

/** Pull the `<style>` block and the markup out of a galaxy element file. */
function split(html) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  const markup = html.replace(/<style>[\s\S]*?<\/style>/, '').trim();
  return { css: style ? style[1].trim() : '', markup };
}

/**
 * Prefix every selector with `scope`, and rename every keyframe.
 *
 * Walks the CSS brace by brace rather than with a regex, because selectors can
 * contain braces-free commas and at-rules nest. Declarations are copied
 * untouched - only the things that can leak out of the element are rewritten.
 */
function scopeCss(css, scope, slug) {
  // Comments first. A `/* ... */` sitting between two rules becomes part of
  // the next rule's prelude otherwise, and gets prefixed as if it were a
  // selector - which produces CSS that parses but never matches. The author's
  // credit is captured before this and re-attached at the top of the file.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const keyframes = new Set();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) keyframes.add(m[1]);

  const renameKeyframe = (name) => `${slug}-${name}`;

  let out = '';
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) { out += css.slice(i); break; }

    const prelude = css.slice(i, brace).trim();
    const isAtRule = prelude.startsWith('@');

    if (isAtRule) {
      if (/^@keyframes/.test(prelude)) {
        // Rename, then copy the whole block verbatim: percentages inside are
        // not selectors and must not be prefixed.
        const end = matchBrace(css, brace);
        const name = /@keyframes\s+([\w-]+)/.exec(prelude)[1];
        out += `@keyframes ${renameKeyframe(name)} ` + css.slice(brace, end + 1) + '\n';
        i = end + 1;
        continue;
      }
      // @media / @supports: keep the prelude, recurse into the body.
      const end = matchBrace(css, brace);
      out += `${prelude} {` + scopeCss(css.slice(brace + 1, end), scope, slug) + '}';
      i = end + 1;
      continue;
    }

    const end = matchBrace(css, brace);
    const body = css.slice(brace + 1, end);
    const selectors = prelude
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === ':root' ? scope : `${scope} ${s}`))
      .join(', ');
    out += `${selectors} {${body}}\n`;
    i = end + 1;
  }

  // Point `animation` at the renamed keyframes.
  for (const name of keyframes) {
    out = out.replace(new RegExp(`(animation(?:-name)?\\s*:[^;}]*?)\\b${name}\\b`, 'g'),
      (_, head) => `${head}${renameKeyframe(name)}`);
  }
  return out;
}

/** Index of the `}` matching the `{` at `open`. */
function matchBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return css.length - 1;
}

await fs.mkdir(OUT, { recursive: true });
const manifest = [];

for (const element of ELEMENTS) {
  const url = `${RAW}/${element.from}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  const html = await response.text();
  const { css, markup } = split(html);

  const scope = `.uiv-${element.slug}`;
  const credit = /\/\*\s*From Uiverse\.io[^*]*\*\//.exec(css)?.[0] ?? '/* From Uiverse.io */';
  const author = /by\s+([\w.-]+)/.exec(credit)?.[1] ?? 'unknown';

  const scoped = scopeCss(css, scope, element.slug);
  const file = [
    `/* Vendored from Uiverse.io (MIT). Do not hand-edit - re-run`,
    ` * scripts/vendor-uiverse.mjs instead.`,
    ` *`,
    ` * Source:  ${url}`,
    ` * Author:  ${author}`,
    ` * ${element.note}`,
    ` *`,
    ` * Selectors are prefixed with ${scope} and keyframes with "${element.slug}-";`,
    ` * everything else is the author's, unchanged.`,
    ` */`,
    '',
    credit,
    scoped,
    '',
  ].join('\n');

  await fs.writeFile(path.join(OUT, `${element.slug}.css`), file, 'utf8');
  manifest.push({ ...element, author, url, markup });
  console.log(`${element.slug.padEnd(14)} <- ${element.from}  (${author})`);
}

await fs.writeFile(
  path.join(OUT, 'manifest.json'),
  `${JSON.stringify({ source: 'https://github.com/uiverse-io/galaxy', licence: 'MIT', elements: manifest }, null, 2)}\n`,
  'utf8'
);
console.log(`\n${manifest.length} elements -> src/registry/uiverse/`);
