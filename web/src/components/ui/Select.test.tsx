/**
 * The closed select must show the option's LABEL, not its value.
 *
 * This is a regression test in the literal sense: converting the native
 * `<select>` elements to Coss/Base UI silently lost it, and the interface then
 * showed `pebble`, `system`, `en` and `2500` where it used to show `Pebble`,
 * `Follow System`, `English` and `2.5s`. A browser does this for free with
 * `<option>`; Base UI only does it when the root is given `items`.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select.js';

function Harness({ initial = 'pebble' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    // `string | null`, because Base UI models "nothing selected" as null -
    // which is why the real call sites all guard before using it.
    <Select value={value} onValueChange={(next) => next && setValue(next)}>
      <SelectTrigger aria-label="Shape">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Mapped, not written out one by one - the real call sites build their
            options from an array, and that is the shape the label collector has
            to see through. */}
        {[
          ['pebble', 'Pebble'],
          ['blob', 'Blob'],
          ['squircle', 'Squircle'],
        ].map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe('Select', () => {
  it('shows the label of the selected option, not the raw value', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Shape')).toHaveTextContent('Pebble');
    expect(screen.getByLabelText('Shape')).not.toHaveTextContent('pebble');
  });

  it('keeps showing the label after the selection changes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Shape'));
    await user.click(await screen.findByRole('option', { name: 'Squircle' }));
    await waitFor(() => expect(screen.getByLabelText('Shape')).toHaveTextContent('Squircle'));
  });

  it('honours an explicit items map instead of deriving one', () => {
    // The opt-out, for a select whose closed label is not the option's text.
    render(
      <Select value="2500" items={{ 2500: 'Every 2.5 seconds' }}>
        <SelectTrigger aria-label="Interval">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="2500">2.5s</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByLabelText('Interval')).toHaveTextContent('Every 2.5 seconds');
  });
});
