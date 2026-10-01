/**
 * What a Cortex body actually did, and how it is set up.
 *
 * The focus card used to show a layer's integration notes and the NAMES of the
 * events that would prove it works - never the events themselves, never the
 * run's result, never a tool's configuration. The owner's first look at Cortex
 * asked exactly that: why can't I see the results, the info, the configuration?
 *
 * This shows, for the selected run, the body's own events in words (with the
 * raw record one click away); the result where the body produces one; and for
 * tools and the bot, their live configuration read from the daemon. It never
 * invents activity: a body with nothing recorded says so.
 */

import { useEffect, useState } from 'react';
import { runLabel } from '../lib/runLabels.js';
import type { GalaxyNode } from '@kernel/cortex/galaxy.js';
import { api, type EventRow, type TaskRunRow } from '../lib/transport.js';
import type { DockerStatus } from '../lib/desktop.js';
import { useCortex } from '../store.js';
import { MessageBody } from './MessageBody.js';
import { StatusPill } from './CortexKit.js';

type Payload = Record<string, unknown>;

function parse(event: EventRow): Payload {
  try {
    const value = JSON.parse(event.payload_json);
    return value && typeof value === 'object' ? (value as Payload) : {};
  } catch {
    return {};
  }
}

export { TITLES, describeEvent } from '../lib/describeEvent.js';
import { describeEvent } from '../lib/describeEvent.js';


function time(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function EventList({ events, empty }: { events: EventRow[]; empty: string }) {
  if (events.length === 0) return <p className="cx-muted">{empty}</p>;
  const shown = events.slice(-8);
  return (
    <>
      <ol className="cx-event-list">
        {shown.map((event, index) => {
          const line = describeEvent(event);
          return (
            <li key={event.id ?? `${event.event_type}-${event.timestamp}-${index}`}>
              <time>{time(event.timestamp)}</time>
              <div>
                <strong>{line.title}</strong>
                {line.detail && <span>{line.detail}</span>}
                {line.link && <a href={line.link.href} target="_blank" rel="noreferrer">{line.link.label}</a>}
                <details>
                  <summary>Record</summary>
                  <pre>{JSON.stringify(parse(event), null, 2)}</pre>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > shown.length && <p className="cx-muted">The latest {shown.length} of {events.length} events.</p>}
    </>
  );
}

function RunResult({ run }: { run: TaskRunRow }) {
  const [report, setReport] = useState<string | null>(null);
  const [missing, setMissing] = useState('');
  useEffect(() => {
    let alive = true;
    setReport(null);
    setMissing('');
    api
      .workResult(run.id)
      .then((body) => { if (alive) setReport(body.result.report); })
      .catch(() => {
        if (alive) setMissing(run.error_message ?? (run.status === 'RUNNING' || run.status === 'QUEUED' ? 'This run has not finished yet.' : 'No result was saved for this run.'));
      });
    return () => { alive = false; };
  }, [run.id, run.status, run.error_message]);
  return (
    <section className="cx-focus-section">
      <h4>Result of this run</h4>
      {report ? <div className="cx-result"><MessageBody content={report} markdown /></div> : <p className="cx-muted">{missing || 'Reading the result…'}</p>}
    </section>
  );
}

function ToolDetails({ node, run, events }: { node: GalaxyNode; run: TaskRunRow | null; events: EventRow[] }) {
  const mcp = useCortex((s) => s.mcp);
  const executor = useCortex((s) => s.executor);
  const agent = useCortex((s) => s.agents.find((a) => a.id === s.selectedAgentId) ?? s.agents[0]);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [system, setSystem] = useState<Awaited<ReturnType<typeof api.botSystem>> | null>(null);

  useEffect(() => {
    let alive = true;
    if (node.id === 'tool-test-container') api.docker().then((body) => { if (alive) setDocker(body.docker); }).catch(() => undefined);
    if (node.id === 'tool-obsidian' && agent) api.botSystem(agent.id).then((body) => { if (alive) setSystem(body); }).catch(() => undefined);
    return () => { alive = false; };
  }, [node.id, agent?.id]);

  const own = events.filter((event) => node.eventTypes.includes(event.event_type) || (node.id === 'tool-mcp' && event.event_type === 'TOOL_CALL' && parse(event).transport === 'mcp'));

  return (
    <>
      <section className="cx-focus-section">
        <h4>Configuration</h4>
        {node.id === 'tool-mcp' && (mcp.length === 0 ? (
          <p className="cx-muted">No MCP servers are configured. Add one from Marketplace → Plugins; it connects after the daemon restarts.</p>
        ) : (
          <ul className="cx-config-list">
            {mcp.map((server) => (
              <li key={server.name}>
                <div className="cx-config-head">
                  <strong>{server.name}</strong>
                  <span className="cx-pill" data-tone={server.connected ? 'ok' : 'warn'}><i aria-hidden="true" />{server.connected ? 'Connected' : 'Not connected'}</span>
                </div>
                {server.error && <p className="cx-muted">{server.error}</p>}
                <p className="cx-muted">{server.tools.length} tools · {server.callsUsed} of {server.quota} calls used</p>
                {server.tools.length > 0 && <div className="cx-chips">{server.tools.slice(0, 12).map((tool) => <code key={tool} className="cx-chip">{tool}</code>)}</div>}
              </li>
            ))}
          </ul>
        ))}
        {node.id === 'tool-obsidian' && (system ? (
          <p>{system.vault.configured ? `A vault is connected for ${agent?.name ?? 'this bot'}.` : `No vault is connected for ${agent?.name ?? 'this bot'}.`} It remembers {system.memory.length} note{system.memory.length === 1 ? '' : 's'}.</p>
        ) : <p className="cx-muted">Reading this bot's memory…</p>)}
        {node.id === 'tool-test-container' && (docker ? <p>{docker.message}</p> : <p className="cx-muted">Checking Docker…</p>)}
        {node.id === 'tool-cost-ledger' && (
          <p>
            {!run
              ? 'Pick a run to see what it cost.'
              : run.actual_cost_usd === 0 && run.turns_taken > 0 && events.some((event) => event.event_type === 'PROVIDER_USAGE_UNKNOWN' || (event.event_type === 'PROVIDER_SERVED' && parse(event).usageSource === 'gateway-reported'))
                // A gateway that reports tokens but no price is not a free run.
                ? `This run took ${run.turns_taken} step${run.turns_taken === 1 ? '' : 's'}. Its price is unknown: the gateway reports usage but not cost, so it is not counted in spend.`
                : `This run cost $${run.actual_cost_usd.toFixed(4)} over ${run.turns_taken} step${run.turns_taken === 1 ? '' : 's'}.`}
            {agent ? ` ${agent.name}'s budget cap is $${agent.budget_cap_usd.toFixed(2)}.` : ''}
          </p>
        )}
        {node.id === 'tool-opencode' && (
          <p>{executor === 'opencode' ? 'This daemon runs tasks through OpenCode sessions.' : `This daemon runs the ${executor ?? 'built-in'} executor, so OpenCode sessions are not used.`}</p>
        )}
      </section>
      <section className="cx-focus-section">
        <h4>In this run</h4>
        {run ? <EventList events={own} empty={`Nothing recorded for ${node.label} in this ${runLabel(run.task_name).toLowerCase()} run.`} /> : <p className="cx-muted">Pick a run to see what this tool did.</p>}
      </section>
    </>
  );
}

function AgentDetails() {
  const agent = useCortex((s) => s.agents.find((a) => a.id === s.selectedAgentId) ?? s.agents[0]);
  const routines = useCortex((s) => s.routines);
  const taskRuns = useCortex((s) => s.taskRuns);
  const selectedRunId = useCortex((s) => s.selectedRunId);
  const selectRun = useCortex((s) => s.selectRun);
  if (!agent) return null;
  const own = routines.filter((routine) => routine.agent_id === agent.id);
  const recent = taskRuns.filter((run) => run.agent_id === agent.id).slice(0, 5);
  return (
    <>
      <section className="cx-focus-section">
        <h4>Configuration</h4>
        <dl className="cx-facts">
          <dt>Model</dt><dd><code>{agent.model_id}</code></dd>
          <dt>Provider</dt><dd>{agent.connection_id ? `${agent.connection_id} · ${agent.routing_mode === 'pinned' ? 'pinned model' : 'automatic routing'}` : 'Direct provider key'}</dd>
          <dt>Budget cap</dt><dd>${agent.budget_cap_usd.toFixed(2)}</dd>
          <dt>Routines</dt><dd>{own.length === 0 ? 'None' : own.map((routine) => `${routine.name}${routine.enabled ? '' : ' (paused)'}`).join(', ')}</dd>
        </dl>
      </section>
      <section className="cx-focus-section">
        <h4>Recent runs</h4>
        {recent.length === 0 ? <p className="cx-muted">No runs yet.</p> : (
          <ul className="cx-run-picks">
            {recent.map((run) => (
              <li key={run.id}>
                <button type="button" aria-pressed={run.id === selectedRunId} onClick={() => void selectRun(run.id)}>
                  <span title={run.task_name}>{runLabel(run.task_name)}</span>
                  <StatusPill status={run.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function NodeInsights({ node }: { node: GalaxyNode }) {
  const events = useCortex((s) => s.events);
  const run = useCortex((s) => s.taskRuns.find((r) => r.id === s.selectedRunId) ?? null);

  if (node.kind === 'agent') return <AgentDetails />;
  if (node.kind === 'tool') return <ToolDetails node={node} run={run} events={events} />;

  const own = events.filter((event) => event.layer === node.layerId || node.eventTypes.includes(event.event_type));
  return (
    <>
      <section className="cx-focus-section">
        <h4>In this run</h4>
        {run ? <EventList events={own} empty={`Nothing was recorded on this layer in this ${runLabel(run.task_name).toLowerCase()} run.`} /> : <p className="cx-muted">Pick a run from the Fleet panel to see what this layer did.</p>}
      </section>
      {run && node.layerId === 9 && <RunResult run={run} />}
    </>
  );
}
