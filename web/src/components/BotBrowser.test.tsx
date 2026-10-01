import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotBrowser } from './BotBrowser.js';
import { api } from '../lib/transport.js';

beforeEach(() => { vi.restoreAllMocks(); });
it('uses the bot screen card for idle and live previews and opens the real browser', async () => {
  const user = userEvent.setup(); const onExpand = vi.fn();
  vi.spyOn(api, 'systemAction').mockResolvedValue({ available: false });
  const { rerender } = render(<BotBrowser agentId="alpha" agentName="Alpha" compact onExpand={onExpand} />);
  expect(await screen.findByText('Idle — no desktop session')).toBeInTheDocument();
  expect(screen.getByText("Alpha's screen")).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Open browser' }));
  expect(onExpand).toHaveBeenCalledOnce();
  vi.mocked(api.systemAction).mockResolvedValue({ available: true, state: { screenshot: 'data:image/jpeg;base64,eA==', login: false } });
  rerender(<BotBrowser agentId="beta" agentName="Beta" compact onExpand={onExpand} />);
  expect(await screen.findByAltText('Live bot browser page')).toBeInTheDocument();
  expect(screen.getByText("Beta's screen")).toBeInTheDocument();
});
it('shows real browser activity and explicitly takes and releases control', async () => {
  const user = userEvent.setup();
  let controlled = false;
  vi.spyOn(api, 'systemAction').mockImplementation(async (action, body: any) => {
    if (action === 'browser-live') return { available: true, state: { url:'https://example.org', action:'navigate', screenshot:'data:image/jpeg;base64,eA==', controlled } };
    if (body.action === 'takeover') controlled = true;
    if (body.action === 'resume') controlled = false;
    return { controlled };
  });
  render(<BotBrowser agentId="alpha" />);
  expect(await screen.findByAltText('Browser page snapshot (not the full desktop)')).toBeInTheDocument();
  expect(screen.queryByLabelText('Type into browser')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name:'Take control'}));
  expect(api.systemAction).toHaveBeenCalledWith('browser-control', {agentId:'alpha', action:'takeover'});
  await user.type(screen.getByLabelText('Type into browser'), 'hello');
  await user.click(screen.getByRole('button', {name:'Type'}));
  expect(api.systemAction).toHaveBeenCalledWith('browser-control', {agentId:'alpha', action:'type', text:'hello'});
  await user.click(screen.getByRole('button', {name:'Resume bot'}));
  await waitFor(() => expect(screen.queryByLabelText('Type into browser')).not.toBeInTheDocument());
});
it('keeps sign-in details out of the shared screen', async () => {
  vi.spyOn(api, 'systemAction').mockResolvedValue({available:true,state:{login:true}});
  render(<BotBrowser agentId="alpha" />);
  expect(await screen.findByText(/Complete sign-in in the browser window/)).toBeInTheDocument();
  expect(screen.queryByRole('button', {name:'Take control'})).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});


