/**
 * The box that asks the operator to do one step.
 *
 * Its wording is written by the model, so these tests pin that a malformed or hostile
 * payload degrades to the ordinary card instead of breaking the panel, and that whatever
 * survives is shown as text rather than interpreted as markup.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readAssist } from './ControlPanel.js';

describe('readAssist', () => {
  it('refuses anything that is not a usable instruction', () => {
    for (const bad of [
      undefined, null, '', 'not json at all', '[]', '{}', 'null', '"a string"', '42',
      '{"what":""}', '{"what":"   "}', '{"what":123}', '{"why":"no what field"}',
    ]) {
      expect(readAssist(bad as string | null | undefined), `payload ${String(bad)} must yield nothing`).toBeUndefined();
    }
  });

  it('keeps the instruction and drops unusable neighbours', () => {
    const assist = readAssist(JSON.stringify({ what: '  Enter the 2FA code  ', why: 7, url: 'https://x.com/login', extra: 'ignored' }));
    expect(assist).toEqual({ what: 'Enter the 2FA code', why: undefined, url: 'https://x.com/login' });
  });

  it('bounds a payload that tries to flood the panel', () => {
    const assist = readAssist(JSON.stringify({ what: 'x'.repeat(9000) }));
    expect(assist?.what.length).toBe(2000);
  });

  it('shows model wording as text, never as markup', () => {
    const injected = '<img src=x onerror="alert(1)"> enter the code 123456';
    const assist = readAssist(JSON.stringify({ what: injected }));
    const { container } = render(
      <div className="cx-root">
        <div className="cx-assist"><p className="cx-assist-what">{assist?.what}</p></div>
      </div>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(injected)).toBeTruthy();
  });
});
