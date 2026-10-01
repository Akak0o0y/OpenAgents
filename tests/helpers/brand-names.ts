/**
 * Where the product name may appear, and which of its old spellings must stay (the 0.6.0 rename spec,
 * docs/superpowers/specs/2026-09-30-openagents-rename-design.md). Shared by the brand audit and the
 * one-off rename script, so the two cannot disagree about what is kept.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Living files. The bot desktop image is the bot's own computer, so only its README counts. */
export const BRAND_ROOTS = ['src', 'tests', 'scripts', 'desktop/src', 'desktop/tests', 'desktop/scripts', 'desktop/assets',
  'desktop/electron-builder.yml', 'desktop/package.json', 'web/src', 'web/public', 'web/scripts', 'web/index.html',
  'web/package.json', 'docker/bot-desktop/README.md', 'docs', 'evals', '.planning', '.github', 'package.json', '.env.example',
  'README.md', 'CLAUDE.md', 'GEMINI.md', 'THIRD_PARTY_NOTICES.md'];

/** Records keep the name that was true when they were written. */
export const DATED = /\d{4}-\d{2}-\d{2}|[\\/]validation[\\/]/;

/** Files whose job is to name the old identifiers: the compatibility layer, its tests and this list. */
export const COMPAT_FILES = new Set(['tests/helpers/brand-names.ts', 'tests/brand-audit.test.ts', 'tests/brand-compat.test.ts',
  'tests/env-alias.test.ts', 'src/kernel/env-alias.ts', 'desktop/src/legacy-profile.mjs', 'desktop/tests/legacy-profile.test.mjs',
  'scripts/lib/app-executable.mjs', 'desktop/tests/app-executable.test.mjs', 'scripts/check-public-tree.mjs']
  .map(file => path.normalize(file)));

/** Identifiers that existing data, containers or external state depend on (spec: "What deliberately stays"). */
export const KEPT: RegExp[] = [
  /OpenHours provider credential v1/g, // DPAPI entropy: every saved provider key
  /openhours_session/g, /openhours-daemon/g, /dev\.openhours\.cortex/g, // cookie, health service, installer and taskbar ID
  /openhours\.[a-z.-]+\.v\d+/g, // browser storage keys
  /\.openhours\b/g, /\bopenhours\?:/g, // the shell's preload bridge, window.openhours
  /openhours\.desktop\.(owner|bot)/g, /openhours-bot-desktop/g, /openhours-browser/g, /openhours-(owner|retain|shell)=?/g,
  /openhours\/opencode-agent/g, /openhours\.opencode\.version/g, /\/opt\/openhours/g, /openhours-chrome/g, // containers and images
  /openhours\.monitor/g, // the bot desktop's sound sink
  /openhours(\.db(\.auth\.json)?|\.config[.*a-z]*\.json|(\.\d+)?\.log)/g, /openhours-dev\.db/g, /openhours-\$\{/g, /\^openhours-/g, // profile files
  /roaming\[\\?\\\/\]openhours/g, // a probe's refusal to write into the real profile folder
  /openhours-attachment/g, /openhours[.:][a-z-]+(\/\d|:data)/g, /openhours-review\b/g, /openhours\/run-/g, // stored markers and tags
  /\.openhours\/skills/g, /openhours-secret-store-probe/g, /OPENHOURS_[A-Z0-9_]+/g, // workspace folder, probe, settings read in code
  /theme-openhours/g, /'openhours'/g, /openhours-icon\.png/g, /openhours-logo\.png/g, // saved theme id and asset paths
  /(APPDATA%?|Roaming|Programs|Desktop)[\\/]+OpenHours(?![A-Za-z-]|\.lnk|\.exe)/g, /Desktop-OpenHours/g, // profile, install and project folders
  /APPDATA \?\? '', 'OpenHours'/g, /'Roaming', 'OpenHours'/g, // the same profile folder, built with path.join
  /Temp[\\/]openhours-[\w-]+/g, // temporary folders named in progress notes
  /example_account/g, // an external X account in test fixtures
  /(formerly|renamed from|pre-0\.6\.0 name) OpenHours/g,
];

/** Regular expressions in source escape dots and slashes; compare what they match. */
export const unescapeLine = (line: string) => line.replace(/\\([./])/g, '$1');

function walk(entry: string): string[] {
  const full = path.resolve(entry);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [path.normalize(entry)];
  return fs.readdirSync(full).filter(name => name !== 'node_modules' && name !== 'dist').flatMap(name => walk(path.join(entry, name)));
}

/** Every living text file under the roots: not dated, not a compatibility file, not binary. */
export function brandFiles(): string[] {
  return BRAND_ROOTS.flatMap(walk)
    .filter(file => !DATED.test(file) && !COMPAT_FILES.has(file) && !fs.readFileSync(path.resolve(file)).includes(0));
}
