import { createRef } from 'react';
import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './input.js';

it.each([true, false])('forwards the input ref and lets its wrapper follow theme changes (native=%s)', nativeInput => {
  const ref = createRef<HTMLInputElement>();
  render(<Input aria-label="Search" nativeInput={nativeInput} ref={ref} />);
  const input = screen.getByRole('textbox', { name: 'Search' });
  expect(ref.current).toBe(input);
  ref.current?.focus();
  expect(input).toHaveFocus();
  expect(input).toHaveClass('bg-transparent');
  expect(input.className).not.toContain('5000000s');
});
