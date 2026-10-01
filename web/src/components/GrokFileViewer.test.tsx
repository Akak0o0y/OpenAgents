import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokFileViewer } from './GrokFileViewer.js';
import { api } from '../lib/transport.js';

vi.mock('../lib/transport.js', () => ({
  api: {
    workspaceFile: vi.fn(),
    saveWorkspaceFile: vi.fn(),
  },
}));

describe('GrokFileViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (window as any).openhours;
  });

  it('renders line numbers and code content with VS Code theme', () => {
    const file = {
      path: 'src/main.ts',
      runId: 'run-123',
      content: 'line 1\nline 2\nline 3',
    };

    const { container } = render(
      <GrokFileViewer
        file={file}
        agentName="Coder"
        codeTheme="monokai"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
    expect(container.querySelector('.theme-monokai')).toBeInTheDocument();

    const lineNumbers = container.querySelectorAll('.grok-code-line-number');
    expect(lineNumbers).toHaveLength(3);
    expect(lineNumbers[0].textContent).toBe('1');
    expect(lineNumbers[1].textContent).toBe('2');
    expect(lineNumbers[2].textContent).toBe('3');

    const textarea = screen.getByRole('textbox', { name: /code editor for src\/main\.ts/i });
    expect(textarea).toHaveValue('line 1\nline 2\nline 3');
  });

  it('tracks dirty state, shows dirty indicator, and enables Save button on edit', async () => {
    const user = userEvent.setup();
    const file = {
      path: 'script.py',
      runId: 'run-456',
      content: 'print("hello")',
    };

    const { container } = render(
      <GrokFileViewer
        file={file}
        agentName="Coder"
        codeTheme="vs-dark"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();
    expect(container.querySelector('.grok-file-dirty-indicator')).toBeNull();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '\nprint("world")');

    expect(saveBtn).not.toBeDisabled();
    expect(container.querySelector('.grok-file-dirty-indicator')).toBeInTheDocument();
  });

  it('saves file via api.saveWorkspaceFile and updates saved status', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveWorkspaceFile).mockResolvedValue({
      success: true,
      runId: 'run-789',
      file: 'notes.txt',
    });

    const file = {
      path: 'notes.txt',
      runId: 'run-789',
      content: 'initial notes',
    };

    render(
      <GrokFileViewer
        file={file}
        agentName="Coder"
        codeTheme="vs-dark"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'updated notes' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).not.toBeDisabled();

    await user.click(saveBtn);

    expect(api.saveWorkspaceFile).toHaveBeenCalledWith('run-789', 'notes.txt', 'updated notes', 'initial notes');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('reverts changes when Revert button is clicked', async () => {
    const user = userEvent.setup();
    const file = {
      path: 'config.json',
      runId: 'run-101',
      content: '{"setting": true}',
    };

    const { container } = render(
      <GrokFileViewer
        file={file}
        agentName="Coder"
        codeTheme="vs-light"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '{"setting": false}' } });

    expect(textarea).toHaveValue('{"setting": false}');
    expect(container.querySelector('.grok-file-dirty-indicator')).toBeInTheDocument();

    const revertBtn = screen.getByRole('button', { name: /discard changes/i });
    await user.click(revertBtn);

    expect(textarea).toHaveValue('{"setting": true}');
    expect(container.querySelector('.grok-file-dirty-indicator')).toBeNull();
  });

  it('toggles between Preview and Code tabs for HTML files', async () => {
    const user = userEvent.setup();
    const file = {
      path: 'report.html',
      runId: 'run-202',
      content: '<h1>Report Title</h1>',
    };

    const { container } = render(
      <GrokFileViewer
        file={file}
        agentName="Coder"
        codeTheme="vs-dark"
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const previewTab = screen.getByRole('tab', { name: /preview/i });
    const codeTab = screen.getByRole('tab', { name: /code/i });

    expect(previewTab).toHaveAttribute('aria-selected', 'true');
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute('srcdoc', '<h1>Report Title</h1>');

    await user.click(codeTab);
    expect(codeTab).toHaveAttribute('aria-selected', 'true');
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('<h1>Report Title</h1>');
  });
  it('returns to chat when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <GrokFileViewer
        file={{ path: 'report.html', content: '<h1>Report</h1>' }}
        agentName="Researcher"
        onBack={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByText(/Esc to chat/)).toBeInTheDocument();
  });
  it('returns to chat through the desktop Escape relay when the preview iframe has focus', () => {
    let escapeHandler: (() => void) | undefined;
    const unsubscribe = vi.fn();
    (window as any).openhours = {
      isDesktop: true,
      keyboard: {
        onEscape: (handler: () => void) => {
          escapeHandler = handler;
          return unsubscribe;
        },
      },
    };
    const onClose = vi.fn();
    const { unmount } = render(
      <GrokFileViewer
        file={{ path: 'report.html', content: '<h1>Report</h1>' }}
        agentName="Researcher"
        onBack={vi.fn()}
        onClose={onClose}
      />
    );

    escapeHandler?.();

    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('keeps edits when the parent refreshes the same file object and preserves a failed save', async () => {
    vi.mocked(api.saveWorkspaceFile).mockResolvedValue({success: false, runId: 'r', file: 'a.txt', reason: 'This file changed.'});
    const props = { agentName: 'Bot', onBack: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<GrokFileViewer {...props} file={{runId: 'r', path: 'a.txt', content: 'old'}} />);
    fireEvent.change(screen.getByRole('textbox'), {target: {value: 'my edits'}});
    rerender(<GrokFileViewer {...props} file={{runId: 'r', path: 'a.txt', content: 'old'}} />);
    expect(screen.getByRole('textbox')).toHaveValue('my edits');
    fireEvent.click(screen.getByRole('button', {name: 'Save'}));
    expect(await screen.findByText(/This file changed/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('my edits');
  });
  it('never allows a partial read to overwrite the full file', async () => {
    vi.mocked(api.workspaceFile).mockResolvedValue({available: true, content: 'partial', truncated: true});
    render(<GrokFileViewer file={{runId: 'r', path: 'large.txt'}} agentName="Bot" onBack={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
  });
});
