/**
 * Operator control: approve or deny a blocked run, and steer a running one.
 *
 * Both refusals are shown, never hidden. An approval nothing is waiting on says
 * so and offers no button; steering an OpenCode run is disabled with the reason
 * on the control itself, because OpenCode owns its conversation inside the
 * container and an injected message would never be read.
 */

import { useEffect, useState } from 'react';
import { UI_LOCALE } from '../lib/numbers.js';
import { api, sendCommand, type ApprovalRow } from '../lib/transport.js';
import { useCortex } from '../store.js';
import type { BotProfile } from '../lib/botProfile.js';
import { Icon } from './ui/icons.js';
import { CortexEmpty, CortexFace, StatusPill } from './CortexKit.js';

/**
 * What the bot is asking a person to do, read out of an approval's payload.
 *
 * Every field here was written by the model, so nothing is trusted: the payload may not
 * be valid JSON, may not be an object, and may hold values of any type. Anything that is
 * not a usable string is dropped, and the result is rendered as text by React rather
 * than as markup.
 */
export function readAssist(payloadJson: string | null | undefined): { what: string; why?: string; url?: string } | undefined {
  if (!payloadJson) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const text = (value: unknown, limit: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
  const record = parsed as Record<string, unknown>;
  const what = text(record.what, 2000);
  if (!what) return undefined;
  return { what, why: text(record.why, 1000), url: text(record.url, 4000) };
}

export function ControlPanel({ profiles }: { profiles: Record<string, BotProfile> }) {
  const runId = useCortex((s) => s.selectedRunId);
  const taskRuns = useCortex((s) => s.taskRuns);
  const agents = useCortex((s) => s.agents);
  const executor = useCortex((s) => s.executor);

  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = taskRuns.find((r) => r.id === runId);
  const agent = agents.find((a) => a.id === run?.agent_id) ?? agents[0];
  const steerable = executor === 'builtin' && run?.status === 'RUNNING';

  const refresh = () => {
    if (!runId) return;
    api.approvals(runId).then((res) => setApprovals(res.approvals)).catch(() => undefined);
  };

  useEffect(refresh, [runId]);

  if (!runId) {
    return (
      <CortexEmpty icon="power" title="No run selected">
        Pick a run to answer its approvals or steer it while it works.
      </CortexEmpty>
    );
  }

  const decide = async (id: string, command: 'approve' | 'deny') => {
    setBusy(true);
    setNote(null);
    try {
      const res = await sendCommand(command, id);
      setNote(res.message ?? res.error ?? null);
    } catch (err: any) {
      setNote(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const steer = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await sendCommand('steer', runId, { message });
      setNote(res.message ?? res.error ?? null);
      if (res.success) setMessage('');
    } catch (err: any) {
      setNote(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const pending = approvals.filter((a) => a.status === 'PENDING');
  const decided = approvals.filter((a) => a.status !== 'PENDING');

  return (
    <div className="cx-stack">
      {agent && (
        <div className="cx-card cx-agent-card">
          <CortexFace agent={agent} profile={profiles[agent.id]} status={run?.status} size={46} interactive />
          <div>
            <strong>{agent.name}</strong>
            <small>{run?.task_name ?? agent.model_id}</small>
          </div>
          <StatusPill status={run?.status ?? agent.current_status} />
        </div>
      )}

      <section className="cx-section">
        <h3 className="cx-section-label">Approvals</h3>
        {approvals.length === 0 && <p className="cx-muted">This run has never requested approval.</p>}

        {pending.map((approval) => {
          // A request for help is not a permission question. It asks the operator to do
          // one step the bot cannot do itself, so it shows what to do and is answered
          // "done" or "I can't" rather than "approve" or "deny".
          const assist = approval.kind === 'human-assist' ? readAssist(approval.payload_json) : undefined;
          return (
          <div key={approval.id} className="cx-card cx-approval">
            <div className="cx-row-between">
              <strong>{assist ? 'Your bot needs you for one step' : approval.kind}</strong>
              <time>{new Date(approval.created_at).toLocaleTimeString(UI_LOCALE)}</time>
            </div>
            {assist && (
              // Rendered as text by React, never as markup: this wording comes from the
              // model, so it is displayed, never interpreted.
              <div className="cx-assist">
                <p className="cx-assist-what">{assist.what}</p>
                {assist.why && <p className="cx-muted">Why it needs you: {assist.why}</p>}
                {assist.url && <p className="cx-muted">Where: {assist.url}</p>}
                <p className="cx-muted">
                  Do it on this bot&rsquo;s own desktop in the viewer, then choose Done. The task is waiting and
                  continues from where it stopped.
                </p>
              </div>
            )}
            {approval.waiting ? (
              <div className="cx-btn-row">
                <button type="button" className="cx-btn primary" disabled={busy} onClick={() => decide(approval.id, 'approve')}>
                  <Icon name="done" size={14} />
                  {assist ? 'Done, continue' : 'Approve'}
                </button>
                <button type="button" className="cx-btn danger" disabled={busy} onClick={() => decide(approval.id, 'deny')}>
                  <Icon name="close" size={14} />
                  {assist ? "I can't do this" : 'Deny'}
                </button>
              </div>
            ) : (
              <p className="cx-muted">
                Pending in the database, but nothing is waiting on it — the task that asked is no longer running in
                this daemon. Deciding it would change nothing.
              </p>
            )}
          </div>
          );
        })}

        {decided.map((approval) => (
          <div key={approval.id} className="cx-card cx-approval is-decided">
            <div className="cx-row-between">
              <strong>{approval.kind}</strong>
              <StatusPill status={approval.status} />
            </div>
            {approval.reason && <p className="cx-muted">{approval.reason}</p>}
          </div>
        ))}
      </section>

      <section className="cx-section">
        <h3 className="cx-section-label">Steer</h3>
        {!steerable && (
          <p className="cx-muted">
            {executor !== 'builtin'
              ? `Unavailable: the "${executor ?? 'unknown'}" executor runs its own loop inside the container, so an injected message would never be read.`
              : `Unavailable: this run is ${run?.status ?? 'not running'}. Only a RUNNING task can be steered.`}
          </p>
        )}
        <div className="cx-composer">
          <textarea
            className="cx-textarea"
            rows={3}
            value={message}
            disabled={!steerable || busy}
            placeholder="Message to inject at the next turn boundary"
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="cx-composer-foot">
            <span className="cx-hint">Read by the bot at its next turn</span>
            <button
              type="button"
              className="cx-btn primary"
              disabled={!steerable || busy || message.trim().length === 0}
              onClick={steer}
            >
              <Icon name="send" size={14} />
              Send steer
            </button>
          </div>
        </div>
        {note && <p className="cx-note" role="status">{note}</p>}
      </section>
    </div>
  );
}
