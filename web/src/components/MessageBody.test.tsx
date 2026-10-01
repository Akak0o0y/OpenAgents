/**
 * Message typesetting.
 *
 * The property worth a test here is not that bold renders — it is that model
 * output never becomes HTML. This component is the only place untrusted text
 * from a model reaches the DOM, so the injection case is asserted directly
 * rather than trusted to the library's defaults staying put.
 *
 * The second property is that the USER's text is left alone. Somebody typing
 * `*` or a line starting with `#` meant those characters, and silently
 * reformatting what a person wrote is its own kind of wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageBody } from './MessageBody.js';

describe('assistant output', () => {
  it('typesets Markdown instead of printing its source', () => {
    const { container } = render(
      <MessageBody markdown content={'## Findings\n\nThe run **failed** twice.'} />
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Findings' })).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('failed');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('##');
  });

  it('renders GitHub tables, and lets a wide one scroll on its own', () => {
    const { container } = render(
      <MessageBody
        markdown
        content={'| Bot | State |\n| --- | --- |\n| Atlas | Idle |'}
      />
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Bot' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Atlas' })).toBeInTheDocument();
    // Without its own scroll container a wide table widens the whole transcript.
    expect(container.querySelector('table')?.parentElement).toHaveClass('grok-md-tablewrap');
  });

  it('renders fenced code as a code block', () => {
    const { container } = render(
      <MessageBody markdown content={'```js\nconst x = 1;\n```'} />
    );
    const code = container.querySelector('pre code');
    expect(code).toHaveTextContent('const x = 1;');
  });

  it('never turns model output into HTML', () => {
    const { container } = render(
      <MessageBody
        markdown
        content={'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'}
      />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The tags survive as characters, which is the whole point: there is no
    // HTML string to sanitise because none is ever produced.
    expect(container.textContent).toContain('<script>alert(2)</script>');
  });

  it('sends links to the browser rather than navigating the app', () => {
    render(<MessageBody markdown content={'[docs](https://example.com/x)'} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});

it('downloads artifacts through authenticated same-origin fetch and shows failures', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));
  try {
    render(<MessageBody markdown content={'[source.js](/api/runs/run-1/artifacts/file-1)'} />);
    await userEvent.click(screen.getByRole('button', { name: 'source.js' }));
    expect(fetch).toHaveBeenCalledWith('/api/runs/run-1/artifacts/file-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('404');
    expect(screen.queryByRole('link', { name: 'source.js' })).not.toBeInTheDocument();
  } finally { fetch.mockRestore(); }
});

describe('the user’s own text', () => {
  it('is shown exactly as typed, not reinterpreted as Markdown', () => {
    const { container } = render(
      <MessageBody markdown={false} content={'## not a heading and *not* emphasis'} />
    );

    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('## not a heading and *not* emphasis');
  });
});
