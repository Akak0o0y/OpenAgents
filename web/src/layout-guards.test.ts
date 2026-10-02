import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every stylesheet ships in one global bundle, so a class name styled in two files styles both components.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : stylesheets(full);
    return name.endsWith('.css') ? [full] : [];
  });
}
const css = (file: string) => readFileSync(path.join(srcDir, file), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(text: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(text);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

describe('layout guards', () => {
  // 2026-10-02: BotWorkspace.css also styled `.oh-settings-nav` as a two-column grid, which pushed the
  // Settings dialog's section list across its content.
  it('styles the Settings dialog navigation from one stylesheet only', () => {
    const owners = stylesheets(srcDir)
      .filter((file) => /\.oh-settings-nav\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file).replace(/\\/g, '/'));
    expect(owners).toEqual(['settings-design.css']);
  });

  // 2026-10-02: the chat's scroll-to-latest (`scrollIntoView`) also scrolls overflow-hidden ancestors. When
  // anything overflowed the shell, the whole workspace slid up under the titlebar and the transparent
  // desktop backdrop showed below it. `clip` cannot be scrolled, by code or otherwise.
  it('keeps the workspace frames unscrollable', () => {
    const theme = css('theme.css');
    expect(rule(theme, '.grok-workspace-container')).toMatch(/overflow:\s*clip;/);
    expect(rule(theme, '.grok-workspace-window')).toMatch(/overflow:\s*clip;/);
    expect(rule(theme, 'html.oh-desktop .grok-chat-pane')).toMatch(/overflow:\s*clip;/);
  });
});
