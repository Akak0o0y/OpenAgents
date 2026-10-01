/**
 * Cortex focus content.
 *
 * The owner asked why clicking a layer or a tool showed no results, info or
 * configuration. These pin the answer: a layer shows its own events for the
 * selected run in words; the answer-shaping layer shows the run's result; tools
 * show their live configuration; the bot shows its setup and lets a recent run
 * be picked - and nothing claims activity that was not recorded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GalaxyNode } from '@kernel/cortex/galaxy.js';
import { NodeInsights, describeEvent } from './NodeInsights.js';
import { useCortex } from '../store.js';
import { api, type EventRow, type TaskRunRow } from '../lib/transport.js';

const node = (patch: Partial<GalaxyNode>): GalaxyNode => ({
  kind: 'layer', id: 'layer-7', label: 'Tool Execution', layerId: 7, status: 'live', position: [0, 0, 0],
  description: '', integration: '', eventTypes: ['TOOL_CALL', 'WORK_VERIFIED'], ...patch,
} as GalaxyNode);

const run: TaskRunRow = { id: 'run-1', agent_id: 'alpha', task_name: 'work:evidence-brief', model_id: 'm', status: 'COMPLETED', turns_taken: 3, actual_cost_usd: 0.0123, started_at: 1, completed_at: 2 };
let sequence = 0;
const event = (event_type: string, payload: unknown, layer: number | null = null): EventRow => ({
  id: ++sequence, task_run_id: 'run-1', agent_id: 'alpha', event_type, payload_json: JSON.stringify(payload), timestamp: Date.UTC(2026, 8, 15, 7, 0, sequence), layer: layer as never,
});

beforeEach(() => {
  vi.restoreAllMocks();
  useCortex.setState({
    agents: [{ id: 'alpha', name: 'Alpha', model_id: 'deepseek/deepseek-v4.1-flash', current_status: 'IDLE', budget_cap_usd: 10, connection_id: 'openrouter', routing_mode: 'auto' }],
    selectedAgentId: 'alpha',
    taskRuns: [run, { ...run, id: 'run-0', task_name: 'chat:thread', status: 'FAILED' }],
    selectedRunId: 'run-1',
    events: [],
    mcp: [],
    routines: [],
    executor: 'builtin',
  } as never);
});

describe('Cortex node insights', () => {
  it('shows what a layer did in the selected run, in words, with the record on demand', () => {
    useCortex.setState({ events: [event('PROMPT_ASSEMBLED', { promptChars: 1200 }, 1), event('TOOL_CALL', { tool: 'web_search', summary: 'Found 5 results' }, 7)] } as never);
    render(<NodeInsights node={node({})} />);
    expect(screen.getByText('Used a tool: web_search')).toBeInTheDocument();
    expect(screen.getByText('Found 5 results')).toBeInTheDocument();
    expect(screen.queryByText('Instructions assembled')).not.toBeInTheDocument();
    expect(screen.getAllByText('Record').length).toBe(1);
  });

  it('says plainly when the layer recorded nothing, or when no run is picked', () => {
    const { unmount } = render(<NodeInsights node={node({})} />);
    expect(screen.getByText(/Nothing was recorded on this layer/)).toBeInTheDocument();
    unmount();
    useCortex.setState({ selectedRunId: null } as never);
    render(<NodeInsights node={node({})} />);
    expect(screen.getByText(/Pick a run from the Fleet panel/)).toBeInTheDocument();
  });

  it('shows the run result on the answer-shaping layer', async () => {
    vi.spyOn(api, 'workResult').mockResolvedValue({ result: { report: 'Final report text', outcome: 'COMPLETED' } });
    render(<NodeInsights node={node({ id: 'layer-9', label: 'Answer Shaping', layerId: 9, eventTypes: ['WORK_REPORT'] })} />);
    expect(await screen.findByText('Final report text')).toBeInTheDocument();
    expect(api.workResult).toHaveBeenCalledWith('run-1');
  });

  it('shows MCP servers with their tools, and what the run cost against the budget', () => {
    useCortex.setState({ mcp: [{ name: 'filesystem', connected: true, tools: ['read_file', 'write_file'], callsUsed: 2, quota: 50 }] } as never);
    const { unmount } = render(<NodeInsights node={node({ kind: 'tool', id: 'tool-mcp', label: 'MCP Servers', eventTypes: [] })} />);
    expect(screen.getByText('filesystem')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('2 tools · 2 of 50 calls used')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    unmount();
    render(<NodeInsights node={node({ kind: 'tool', id: 'tool-cost-ledger', label: 'Cost Ledger', layerId: 12, eventTypes: ['TASK_COMPLETED'] })} />);
    expect(screen.getByText(/This run cost \$0\.0123 over 3 steps\. Alpha's budget cap is \$10\.00\./)).toBeInTheDocument();
  });

  it('shows the bot configuration and lets a recent run be picked', async () => {
    const user = userEvent.setup();
    const selectRun = vi.fn(async () => undefined);
    useCortex.setState({ selectRun } as never);
    render(<NodeInsights node={node({ kind: 'agent', id: 'agent', label: 'Alpha', eventTypes: [] })} />);
    expect(screen.getByText('deepseek/deepseek-v4.1-flash')).toBeInTheDocument();
    expect(screen.getByText('openrouter · automatic routing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Chat/ }));
    expect(selectRun).toHaveBeenCalledWith('run-0');
  });

  it('describes files with a link and falls back to the most telling field', () => {
    const file = describeEvent(event('ARTIFACT_CREATED', { path: 'report.md', bytes: 2048, downloadUrl: '/api/runs/run-1/artifacts/a' }));
    expect(file.title).toBe('Saved a file: report.md');
    expect(file.detail).toBe('2,048 bytes');
    expect(file.link).toEqual({ href: '/api/runs/run-1/artifacts/a', label: 'Open' });
    const unknown = describeEvent(event('SOMETHING_NEW', { reason: 'A reason' }));
    expect(unknown.title).toBe('Something new');
    expect(unknown.detail).toBe('A reason');
  });
});
