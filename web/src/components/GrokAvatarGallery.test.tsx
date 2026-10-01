/**
 * Avatar gallery behaviour.
 *
 * The family row groups twelve silhouettes into three browsable sets, and the
 * note under it states what is and is not third-party. That statement is
 * asserted here, because it is the only place an operator is told which parts
 * of the avatar they can ship.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokAvatarGallery, type GalleryValue } from './GrokAvatarGallery.js';

/**
 * The options a Coss Select offers.
 *
 * A native `<select>` exposes `.options` synchronously whether or not it is
 * open. A Base UI listbox does not exist in the DOM until the trigger is
 * pressed, so reading the choices means opening it - and closing it again, or
 * the next query in the same test finds two listboxes.
 *
 * These assertions are about which choices are OFFERED, which is behaviour, so
 * they survive the change of implementation. What did not survive was reading
 * `HTMLSelectElement.options`, which was the old element's API rather than the
 * component's contract.
 */
async function openSelect(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByLabelText(label));
  // Scoped to the select's own popup, NOT `getByRole('listbox')`. The
  // expression strip on this same screen is a listbox too, so an unscoped
  // query matches two and fails - which is a fair complaint about the query,
  // not about the component.
  return waitFor(() => {
    // The popup whose options are actually REACHABLE, newest first.
    //
    // A popup that is closing stays in the DOM for its exit animation, so
    // opening a second select while the first is still leaving leaves two
    // positioners here. Worse, the stale one still contains `[role=option]`
    // nodes - it is only `aria-hidden` - so a raw `querySelectorAll` check
    // accepts it and every later `getByRole` then fails, because that one is
    // accessibility-aware and the raw query is not. Asking by role here means
    // the helper and the assertions agree on what counts as present.
    const popups = [...document.querySelectorAll('[data-slot="select-positioner"]')].reverse();
    for (const candidate of popups) {
      const scope = within(candidate as HTMLElement);
      if (scope.queryAllByRole('option').length > 0) return scope;
    }
    throw new Error('select popup did not open');
  });
}

async function optionsOf(user: ReturnType<typeof userEvent.setup>, label: string) {
  const popup = await openSelect(user, label);
  const labels = popup.getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

/** Choose an option by its visible text. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: RegExp | string) {
  const popup = await openSelect(user, label);
  await user.click(popup.getByRole('option', { name: option }));
}


vi.mock('./BotFace.js', () => ({
  BotFace: () => null,
  usePrefersReducedMotion: () => false,
}));

const value: GalleryValue = {
  shape: 'pebble',
  color: '#2C86F0',
  eyeColor: '#FFFFFF',
  emotion: '02',
  sketch: false,
};

function setup(overrides: Partial<GalleryValue> = {}) {
  const onChange = vi.fn();
  render(<GrokAvatarGallery value={{ ...value, ...overrides }} onChange={onChange} />);
  return { onChange };
}

describe('family row', () => {
  it('offers the three browsing families', () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: 'Character family' });
    for (const name of ['Rounds', 'Angular', 'Organic']) {
      expect(within(group).getByRole('radio', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it('states plainly what is original and what is licensed', () => {
    setup();
    expect(screen.getByText(/OpenAgents-original geometry/)).toBeInTheDocument();
    expect(screen.getByText(/no third-party character artwork is/)).toBeInTheDocument();
    expect(screen.getByText(/separately licensable for commercial use/)).toBeInTheDocument();
  });

  it('switches family by selecting a shape from it', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('radio', { name: /Angular/ }));
    expect(onChange).toHaveBeenCalledWith({ shape: 'wedge' });
  });

  it('offers only the selected family shapes in the shape picker', async () => {
    setup();
    const user = userEvent.setup();
    expect(await optionsOf(user, 'Shape')).toEqual([
      'Blob',
      'Pebble',
      'Squircle',
      'Tablet',
      'Capsule',
    ]);
  });

  it('shows the selected shape by its label, not its raw value', () => {
    // The closed picker read `pebble` in the shipped app, and `2500` next to
    // it, because converting these away from native <select> lost the option
    // text. See components/ui/Select.tsx.
    setup({ shape: 'pebble' });
    expect(screen.getByLabelText('Shape')).toHaveTextContent('Pebble');
    expect(screen.getByLabelText('Interval')).toHaveTextContent('2.5s');
    expect(screen.getByLabelText('Group')).toHaveTextContent(/^All \(\d+\)$/);
  });

  it('never offers the removed Aora silhouette', async () => {
    setup({ shape: 'wedge' });
    const user = userEvent.setup();
    const options = await optionsOf(user, 'Shape');
    expect(options).toEqual(['Wedge', 'Hex', 'Crystal', 'Shard']);
    expect(options).not.toContain('Gem');
  });
});

describe('expressions', () => {
  it('lists the engine 32 expressions and can filter them by group', async () => {
    const user = userEvent.setup();
    setup();
    expect(await optionsOf(user, 'Group')).toContain('All (32)');

    const strip = () => within(screen.getByRole('listbox', { name: 'Expressions' }));
    expect(strip().getAllByRole('option')).toHaveLength(32);
    await choose(user, 'Group', /Life/i);
    expect(strip().getAllByRole('option')).toHaveLength(8);
  });

  it('marks the current expression selected and reports a click', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    const strip = within(screen.getByRole('listbox', { name: 'Expressions' }));
    expect(strip.getByRole('option', { name: /Idle/ })).toHaveAttribute('aria-selected', 'true');

    await user.click(strip.getByRole('option', { name: /Sleeping/ }));
    expect(onChange).toHaveBeenCalledWith({ emotion: '00' });
  });

  it('steps forward and back with the arrows', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Next expression' }));
    expect(onChange).toHaveBeenCalledWith({ emotion: '03' });

    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'Previous expression' }));
    expect(onChange).toHaveBeenCalledWith({ emotion: '01' });
  });

  it('wraps around at both ends rather than stopping', async () => {
    const user = userEvent.setup();
    const first = setup({ emotion: '00' });
    await user.click(screen.getByRole('button', { name: 'Previous expression' }));
    expect(first.onChange).toHaveBeenCalledWith({ emotion: '41' });
  });

  it('describes the current expression, not just its name', () => {
    setup();
    expect(screen.getByText(/Glances left, glances right/)).toBeInTheDocument();
  });
});

describe('views and controls', () => {
  it('switches between the album and the wall', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('button', { name: 'Next expression' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Wall' }));
    expect(screen.queryByRole('button', { name: 'Next expression' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('listbox', { name: 'Expressions' })).getAllByRole('option')
    ).toHaveLength(32);
  });

  it('keeps the interval inert until autoplay is on', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByLabelText('Interval')).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Autoplay' }));
    expect(screen.getByLabelText('Interval')).toBeEnabled();
  });

  it('reports the sketch toggle', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('switch', { name: 'Sketch' }));
    expect(onChange).toHaveBeenCalledWith({ sketch: true });
  });

  it('gives a light body dark eyes when a colour is picked', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('radio', { name: 'Black' }));
    expect(onChange).toHaveBeenCalledWith({ color: expect.any(String), eyeColor: '#1A1A1A' });

    onChange.mockClear();
    await user.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(onChange).toHaveBeenCalledWith({ color: expect.any(String), eyeColor: '#FFFFFF' });
  });
});
