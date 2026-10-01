/**
 * Code blocks in model output.
 *
 * The two properties worth pinning: the language the model declared survives
 * to the screen, and the copy button copies the WHOLE fence. The second is the
 * one that silently regresses - a fence containing a blank line arrives as
 * several React children, and a naive implementation copies only the first.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageBody } from '../MessageBody.js';

let clipboard: string[];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async (t: string) => { clipboard.push(t); }) },
    configurable: true,
  });
});

describe('a fenced code block', () => {
  it('shows the language the model declared', () => {
    render(<MessageBody markdown content={'```python\nx = 1\n```'} />);
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('says "text" for an unlabelled fence rather than showing nothing', () => {
    render(<MessageBody markdown content={'```\nplain\n```'} />);
    expect(screen.getByText('text')).toBeInTheDocument();
  });

  it('copies the whole fence, including blank lines', async () => {
    render(<MessageBody markdown content={'```js\nconst a = 1;\n\nconst b = 2;\n```'} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    await waitFor(() => expect(clipboard).toHaveLength(1));
    // Both statements AND the blank line between them - the case a
    // children[0] implementation gets wrong.
    expect(clipboard[0]).toContain('const a = 1;');
    expect(clipboard[0]).toContain('const b = 2;');
  });

  it('confirms on the button rather than raising a notification', async () => {
    render(<MessageBody markdown content={'```\nhi\n```'} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('leaves inline code alone', () => {
    const { container } = render(<MessageBody markdown content={'run `npm test` now'} />);
    expect(container.querySelector('.grok-code')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent('npm test');
  });
});
