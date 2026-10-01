#!/usr/bin/env node
/**
 * Vendor components from the Coss UI registry.
 *
 * Coss is distributed the shadcn way - copy the source and own it - rather than
 * as an npm package. This fetches from their registry and writes the files
 * where their own imports expect to find them, so each component lands
 * VERBATIM. Nothing is rewritten on the way in.
 *
 * WHY VERBATIM MATTERS. A vendored file that has been edited on arrival cannot
 * be updated: the next version has to be merged by hand against changes nobody
 * wrote down. Kept byte-identical, updating is re-running this script and
 * reading a diff. Anything this app needs to change about a component belongs
 * in a wrapper beside it, not in the file itself.
 *
 * THEMING IS NOT DONE HERE. These components use Tailwind class names -
 * `bg-background`, `ring-ring`, `rounded-lg` - and src/tailwind.css maps every
 * one of those names onto this app's own `--gk-*` tokens. So they arrive
 * already wearing the OpenAgents palette without a line of them being touched.
 *
 * Licence: Coss UI's apps/ui is MIT (the wider repository is AGPLv3; the UI
 * directory is separately licensed). Recorded in THIRD_PARTY_NOTICES.md.
 *
 * Usage:
 *   node scripts/vendor-coss.mjs button dialog table
 *   node scripts/vendor-coss.mjs --list
 *   node scripts/vendor-coss.mjs --core        # the 53 real components
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const REGISTRY = 'https://coss.com/ui/r';

/**
 * Everything that is not a `p-*` preview.
 *
 * The registry carries 577 entries, but most are numbered examples - eleven
 * different autocompletes showing eleven layouts. Those are documentation, not
 * components.
 */
async function coreNames() {
  const res = await fetch(`${REGISTRY}/registry.json`);
  if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body) ? body : (body.items ?? []);
  return items
    .map((item) => item.name)
    .filter((name) => typeof name === 'string' && !name.startsWith('p-') && name !== 'ui');
}

async function fetchComponent(name) {
  const res = await fetch(`${REGISTRY}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

/** Registry dependencies arrive as `@coss/spinner`; the registry key is the tail. */
function registryKey(dependency) {
  return dependency.replace(/^@coss\//, '');
}

/**
 * Fetch a component and everything it needs, breadth-first.
 *
 * Their `registryDependencies` are what makes a partial copy fail at runtime -
 * the button imports a spinner, and a button without one is a build error
 * rather than a missing feature.
 */
async function resolve(names) {
  const queue = [...names];
  const seen = new Set();
  const out = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    let component;
    try {
      component = await fetchComponent(name);
    } catch (cause) {
      console.warn(`  ! skipped ${name}: ${cause.message}`);
      continue;
    }
    out.push(component);

    for (const dep of component.registryDependencies ?? []) {
      const key = registryKey(dep);
      if (!seen.has(key)) queue.push(key);
    }
  }
  return out;
}

/** npm packages the vendored files import, so a missing one is reported once. */
function npmDependencies(components) {
  const deps = new Set();
  for (const c of components) for (const d of c.dependencies ?? []) deps.add(d);
  return [...deps].sort();
}

// ------------------------------------------------------------------- main ---

const args = process.argv.slice(2);

if (args.includes('--list')) {
  const names = await coreNames();
  console.log(`${names.length} components:\n`);
  console.log(names.join(', '));
  process.exit(0);
}

const requested = args.includes('--core') ? await coreNames() : args.filter((a) => !a.startsWith('--'));
if (requested.length === 0) {
  console.error('Name at least one component, or pass --core or --list.');
  process.exit(1);
}

console.log(`Resolving ${requested.length} component(s) and their registry dependencies…`);
const components = await resolve(requested);

let written = 0;
for (const component of components) {
  for (const file of component.files ?? []) {
    if (!file.path || typeof file.content !== 'string') continue;
    // `registry/default/ui/button.tsx` -> `src/registry/default/ui/button.tsx`,
    // which is exactly where their own `@/registry/default/...` imports point
    // once the alias in vite.config.ts maps `@` to `src`.
    const target = path.join(webRoot, 'src', file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written += 1;
  }
}

console.log(`\nVendored ${components.length} component(s), ${written} file(s).`);

const missing = npmDependencies(components).filter((dep) => {
  const name = dep.replace(/@[\^~]?[\d.].*$/, '');
  try {
    return !fs.existsSync(path.join(webRoot, 'node_modules', name));
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  console.log(`\nThese npm packages are imported and not installed:\n  npm install ${missing.join(' ')}`);
}
