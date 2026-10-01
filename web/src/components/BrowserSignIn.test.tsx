import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserSignIn } from './BrowserSignIn.js';
import { api } from '../lib/transport.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'botSystem').mockResolvedValue({ browser: { sessions: [], desktop: { state: 'stopped' } } } as never);
  vi.spyOn(api, 'systemAction').mockResolvedValue({ opened: true, desktop: true, runId: 'login-alpha' });
});
it('opens bot-owned Chrome without offering an extension or personal browser', async () => {
  const user = userEvent.setup();
  render(<BrowserSignIn agentId="alpha" site="x.com" approvalId="request-1" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  expect(api.systemAction).toHaveBeenCalledWith('browser-login', { agentId: 'alpha', url: 'https://x.com', approvalId: 'request-1' });
  expect(screen.getByTitle('Bot desktop — Chrome')).toHaveAttribute('src', '/api/desktop/alpha/viewer.html');
  expect(screen.queryByText(/extension|Connect browser/)).not.toBeInTheDocument();
});
it('cancels the open login using its run identity and closes the viewer', async () => {
  const user = userEvent.setup();
  render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(api.systemAction).toHaveBeenCalledWith('browser-login-cancel', { agentId: 'alpha', runId: 'login-alpha' });
  expect(screen.queryByTitle('Bot desktop — Chrome')).not.toBeInTheDocument();
});

it('cancels its open session on unmount', async () => {
  const user = userEvent.setup();
  const view = render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  view.unmount();
  expect(api.systemAction).toHaveBeenCalledWith('browser-login-cancel', { agentId: 'alpha', runId: 'login-alpha' });
});
it('keeps the viewer and shows a failed cancellation so cleanup can be retried', async () => {
  const user = userEvent.setup();
  render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  vi.mocked(api.systemAction).mockRejectedValueOnce(new Error('Desktop cleanup failed'));
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Desktop cleanup failed');
  expect(screen.getByTitle('Bot desktop — Chrome')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeEnabled();
});

it('cancels an opening session when its delayed response arrives', async () => {
  const user = userEvent.setup(); let finish!: (value: any) => void;
  vi.mocked(api.systemAction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await act(async () => finish({ opened: true, desktop: true, runId: 'late-cancel' }));
  expect(api.systemAction).toHaveBeenCalledWith('browser-login-cancel', { agentId: 'alpha', runId: 'late-cancel' });
  expect(screen.queryByTitle('Bot desktop — Chrome')).not.toBeInTheDocument();
});
it('keeps sign-in open when saving fails and permits retry', async () => {
  const user = userEvent.setup(), saved = vi.fn();
  vi.mocked(api.botSystem).mockResolvedValue({ browser: { sessions: [{ login: true }], desktop: { state: 'ready' } } } as never);
  vi.mocked(api.systemAction).mockRejectedValueOnce(new Error('Sign-in is not complete.')).mockResolvedValue({ saved: true, verified: false });
  render(<BrowserSignIn agentId="alpha" site="x.com" onSaved={saved} />);
  await user.click(await screen.findByRole('button', { name: 'Save sign-in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is not complete.');
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByTitle('Bot desktop — Chrome')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save sign-in' }));
  expect(saved).toHaveBeenCalledOnce();
  expect(screen.getByText(/Sign-in saved/)).toBeInTheDocument();
  expect(screen.queryByText('Sign-in verified.')).not.toBeInTheDocument();
});
it('ignores a late response after switching bots', async () => {
  const user = userEvent.setup(); let finish!: (value: any) => void;
  vi.mocked(api.systemAction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  view.rerender(<BrowserSignIn agentId="beta" site="example.org" />);
  await act(async () => finish({ opened: true, desktop: true, runId: 'late-alpha' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeEnabled());
  expect(screen.queryByTitle('Bot desktop — Chrome')).not.toBeInTheDocument();
  expect(api.systemAction).toHaveBeenCalledWith('browser-login-cancel', { agentId: 'alpha', runId: 'late-alpha' });
});

it('reports first-use preparation and allows cancelling without opening a browser later', async () => {
  const user = userEvent.setup();
  vi.mocked(api.systemAction).mockResolvedValue({ opened: false, preparing: true, desktop: true });
  render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  expect(screen.getByRole('status')).toHaveTextContent('Preparing your bot’s desktop');
  expect(screen.queryByTitle('Bot desktop — Chrome')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('Sign-in cancelled');
  expect(api.systemAction).toHaveBeenCalledTimes(1);
});

it('opens sign-in automatically when background desktop preparation becomes ready', async () => {
  const user = userEvent.setup();
  vi.mocked(api.systemAction).mockResolvedValueOnce({ opened: false, preparing: true, desktop: true }).mockResolvedValue({ opened: true, desktop: true });
  render(<BrowserSignIn agentId="alpha" site="x.com" />);
  await user.click(screen.getByRole('button', { name: 'Sign in securely' }));
  vi.mocked(api.botSystem).mockResolvedValue({ browser: { sessions: [], desktop: { state: 'stopped' }, desktopSetup: { state: 'ready', message: 'Ready' } } } as never);
  await waitFor(() => expect(screen.getByTitle('Bot desktop — Chrome')).toBeInTheDocument(), { timeout: 4000 });
  expect(api.systemAction).toHaveBeenCalledTimes(2);
});
