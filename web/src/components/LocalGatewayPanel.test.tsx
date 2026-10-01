/**
 * The FreeLLMAPI panel in Settings → Providers.
 *
 * It must say plainly what state the gateway OpenAgents runs is in, let a person
 * start it or point OpenAgents at its folder, tell the connection list to reload
 * once it is running (its port may have moved), and disappear entirely where the
 * daemon does not manage a gateway.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalGatewayPanel } from './LocalGatewayPanel.js';
import { api, type LocalGatewayStatus } from '../lib/transport.js';

const base: LocalGatewayStatus = {
  state: 'stopped', directory: 'C:\\Users\\me\\Desktop\\freellmapi', detected: 'C:\\Users\\me\\Desktop\\freellmapi',
  port: 41790, baseUrl: 'http://127.0.0.1:41790/v1', dashboardUrl: 'http://127.0.0.1:41790/', autoStart: true,
  message: '', pid: null, log: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('FreeLLMAPI panel', () => {
  it('starts the gateway, shows its address, and asks the connection list to reload once it runs', async () => {
    const user = userEvent.setup();
    const status = vi.spyOn(api, 'localGateway').mockResolvedValue({ gateway: base });
    const running: LocalGatewayStatus = { ...base, state: 'running', port: 43001, baseUrl: 'http://127.0.0.1:43001/v1', dashboardUrl: 'http://127.0.0.1:43001/', message: 'Running on port 43001.', pid: 99 };
    const action = vi.spyOn(api, 'localGatewayAction').mockImplementation(async () => {
      // As the daemon does: once started, status reads report it running too.
      status.mockResolvedValue({ gateway: running });
      return { gateway: running };
    });
    const onRunning = vi.fn();
    render(<LocalGatewayPanel onRunning={onRunning} />);

    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:41790/v1')).toBeInTheDocument();
    expect(screen.getByText(/Found automatically at/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start FreeLLMAPI' }));
    expect(action).toHaveBeenCalledWith({ action: 'start' });
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:43001/v1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open its dashboard' })).toHaveAttribute('href', 'http://127.0.0.1:43001/');
    expect(onRunning).toHaveBeenCalledTimes(1);
  });

  it('points OpenAgents at a folder when it was not found, and shows a refusal', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'localGateway').mockResolvedValue({ gateway: { ...base, state: 'not-found', directory: null, detected: null, message: 'FreeLLMAPI was not found on this computer.' } });
    const action = vi.spyOn(api, 'localGatewayAction').mockRejectedValueOnce(new Error('C:\\Temp is not a FreeLLMAPI folder'));
    render(<LocalGatewayPanel />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start FreeLLMAPI' })).toBeDisabled();
    await user.type(screen.getByLabelText('Folder'), 'C:\\Temp');
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(action).toHaveBeenCalledWith({ action: 'configure', directory: 'C:\\Temp' });
    expect(await screen.findByText(/is not a FreeLLMAPI folder/)).toBeInTheDocument();
  });

  it('is absent where the daemon does not manage a gateway', async () => {
    const status = vi.spyOn(api, 'localGateway').mockRejectedValue(new Error('This daemon does not manage a local gateway.'));
    const { container } = render(<LocalGatewayPanel />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
