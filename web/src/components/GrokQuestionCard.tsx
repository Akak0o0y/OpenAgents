import { BrowserSignIn } from './BrowserSignIn.js';
import { CharacterProposalCard } from './CharacterProposalCard.js';
/**
 * Question and approval cards in the transcript.
 *
 * These are NOT decoration. Every card on screen is a row in the daemon's
 * `approvals` table: a real task, blocked, waiting for an answer. That is why
 * there is no "create a question" path in this file - the UI cannot invent one,
 * and a card that appears without a blocked task would be a lie about what the
 * fleet is doing.
 *
 * Two shapes are rendered:
 *
 *   - A QUESTION: the payload carries `question` and `options`, so the card
 *     shows lettered answers and, when the payload allows it, a free-text box.
 *   - Anything else: a plain approval, showing its kind and payload, with
 *     Approve and Deny.
 *
 * A PENDING row whose `waiting` flag is false is answerable in the database but
 * connected to nothing - the daemon that was waiting on it has gone. The card
 * says so and disables its buttons rather than offering an action that would
 * change a row and free nothing.
 */

import { useState } from 'react';
import { UI_LOCALE } from '../lib/numbers.js';
import { Icon } from './ui/icons.js';
import type { ApprovalRow } from '../lib/transport.js';
import { Button } from './ui/Button.js';
import { Input } from '@/registry/default/ui/input.js';

export interface QuestionOption {
  id: string;
  label: string;
}

export interface ParsedApproval {
  row: ApprovalRow;
  question: string | null;
  options: QuestionOption[];
  allowCustom: boolean;
  /** Key facts a person needs to decide, in plain words. */
  points: string[];
  /** The raw payload, kept under "Technical details". */
  summary: string;
}

const LETTERS = 'ABCDEFGHIJ';

export function parseApproval(row: ApprovalRow): ParsedApproval {
  let payload: any = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }

  const question =
    payload && typeof payload.question === 'string' && payload.question.trim()
      ? payload.question.trim()
      : null;

  const rawOptions = Array.isArray(payload?.options) ? payload.options : [];
  const options: QuestionOption[] = rawOptions
    .map((option: unknown, index: number) => {
      if (typeof option === 'string') return { id: option, label: option };
      if (option && typeof option === 'object') {
        const record = option as Record<string, unknown>;
        const label = typeof record.label === 'string' ? record.label : String(record.id ?? '');
        const id = typeof record.id === 'string' ? record.id : label || String(index);
        return label ? { id, label } : null;
      }
      return null;
    })
    .filter((option: QuestionOption | null): option is QuestionOption => option !== null)
    .slice(0, LETTERS.length);

  const described = describeApproval(row.kind, payload);
  return {
    row,
    question: question ?? described.title,
    options,
    allowCustom: payload?.allowCustom !== false,
    points: Array.isArray(payload?.points)
      ? payload.points.filter((point: unknown): point is string => typeof point === 'string' && point.trim() !== '').slice(0, 8)
      : described.points,
    summary: payload ? JSON.stringify(payload, null, 2) : row.payload_json,
  };
}

/**
 * A readable title and key facts for an approval that carries no question of
 * its own. The raw payload stays available under "Technical details" - it is
 * the record - but a person should never have to read JSON to decide.
 */
export function describeApproval(kind: string, payload: any): { title: string; points: string[] } {
  const text = (value: unknown, max = 240) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const minutes = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? Math.round(ms / 60000) : null);
  switch (kind) {
    case 'mission-start': {
      const every = minutes(payload?.intervalMs);
      return {
        title: 'Start this mission?',
        points: [
          text(payload?.objective, 600),
          typeof payload?.maxRuns === 'number' ? `Up to ${payload.maxRuns} work steps${every ? `, at least ${every} minutes apart` : ''}.` : null,
          'It keeps working in the background, and you can pause or stop it any time.',
        ].filter((point): point is string => Boolean(point)),
      };
    }
    case 'routine-create':
      return { title: `Create the routine “${text(payload?.name, 80) ?? 'Untitled'}”?`, points: [text(payload?.schedule), text(payload?.instruction, 600)].filter((p): p is string => Boolean(p)) };
    case 'account-request':
      return {
        title: `Sign in to ${text(payload?.site, 120) ?? 'this site'}?`,
        points: [text(payload?.reason, 600), 'Sign in securely in a separate window. Your session is saved only for this bot.'].filter((p): p is string => Boolean(p)),
      };
    case 'browser-interaction':
      return { title: `Let the bot use forms and buttons on ${text(payload?.origin) ?? 'this site'}?`, points: [text(payload?.scope)].filter((p): p is string => Boolean(p)) };
    case 'mcp-call':
      return { title: `Run the ${text(payload?.tool, 80) ?? 'requested'} tool from ${text(payload?.server, 80) ?? 'an MCP server'}?`, points: [] };
    case 'scheduled-work':
      return { title: 'Run this scheduled routine now?', points: [text(payload?.request, 600)].filter((p): p is string => Boolean(p)) };
    case 'chat':
    case 'direct-work':
      return { title: 'Let the bot answer this request?', points: ['This bot is set to ask before it works.'] };
    default:
      return { title: `${kind.replace(/[-_]/g, ' ')} request`, points: [] };
  }
}

interface GrokQuestionCardProps {
  approval: ParsedApproval;
  busy: boolean;
  onAnswer: (approvalId: string, decision: 'approve' | 'deny', reason?: string) => void;
}

export function GrokQuestionCard({ approval, busy, onAnswer }: GrokQuestionCardProps) {
  const [custom, setCustom] = useState('');
  const { row, question, options, allowCustom } = approval;
  const pending = row.status === 'PENDING';
  const orphaned = pending && !row.waiting;
  if (row.kind === 'character-change') {
    try { const payload=JSON.parse(row.payload_json); if(typeof payload.proposalId==='string') return <CharacterProposalCard key={`${row.agent_id}:${payload.proposalId}`} agentId={row.agent_id} proposalId={payload.proposalId}/>; }
    catch { /* Existing malformed approval rendering follows. */ }
  }

  if (!pending) {
    // Completed: the question, the one answer that was chosen, and nothing that
    // invites another answer.
    const answered = row.status === 'APPROVED';
    const chosen = row.reason?.trim();
    const chosenIndex = options.findIndex((option) => option.label === chosen || option.id === chosen);
    return (
      <article className="grok-question-card completed" aria-label="Answered question">
        <h3 className="grok-question-title">{question ?? `${row.kind} request`}</h3>
        <div className="grok-question-answer-row completed">
          <span className="grok-question-letter" aria-hidden="true">
            {chosenIndex >= 0 ? (
              LETTERS[chosenIndex]
            ) : (
              <Icon name={answered ? 'done' : 'close'} size={14} />
            )}
          </span>
          <span className="grok-question-answer-label">
            {chosen || (answered ? 'Approved' : row.status === 'DENIED' ? 'Declined' : 'Expired')}
          </span>
          <span className={`grok-question-check ${answered ? '' : 'muted'}`} aria-hidden="true">
            <Icon name={answered ? 'done' : 'close'} size={14} />
          </span>
        </div>
        <p className="grok-question-meta">
          {row.status === 'EXPIRED'
            ? 'Expired before it was answered.'
            : `Answered ${new Date(row.decided_at ?? row.created_at).toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}`}
        </p>
      </article>
    );
  }

  return (
    <article className="grok-question-card" aria-label="Question awaiting an answer">
      <header className="grok-question-header">
        <h3 className="grok-question-title">{question ?? `${row.kind} request`}</h3>
        <button
          type="button"
          className="grok-question-dismiss"
          title="Decline this request"
          aria-label="Decline this request"
          disabled={busy || orphaned}
          onClick={() => onAnswer(row.id, 'deny')}
        >
          <Icon name="close" />
        </button>
      </header>

      {orphaned && (
        <p className="grok-question-orphaned" role="status">
          The run that asked this is no longer active in the daemon. Answering would
          record a decision that nothing is waiting for.
        </p>
      )}

      {row.kind === 'account-request' ? (
        <>
          {approval.points.length > 0 && (
            <ul className="grok-approval-points">
              {approval.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
          <AccountRequestForm row={row} disabled={busy || orphaned} onDecline={() => onAnswer(row.id, 'deny')} />
        </>
      ) : options.length > 0 ? (
        <div className="grok-question-options" role="group" aria-label="Answers">
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className="grok-question-answer-row"
              disabled={busy || orphaned}
              onClick={() => onAnswer(row.id, 'approve', option.label)}
            >
              <span className="grok-question-letter" aria-hidden="true">{LETTERS[index]}</span>
              <span className="grok-question-answer-label">{option.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {approval.points.length > 0 && (
            <ul className="grok-approval-points">
              {approval.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
          <details className="grok-approval-technical">
            <summary>Technical details</summary>
            <pre className="grok-approval-payload">{approval.summary}</pre>
          </details>
          <div className="grok-question-actions">
            <Button kind="primary" disabled={busy || orphaned} onClick={() => onAnswer(row.id, 'approve')}
            >
              Approve
            </Button>
            <Button kind="secondary" disabled={busy || orphaned} onClick={() => onAnswer(row.id, 'deny')}
            >
              Deny
            </Button>
          </div>
        </>
      )}

      {options.length > 0 && allowCustom && (
        <form
          className="grok-question-custom"
          onSubmit={(event) => {
            event.preventDefault();
            const answer = custom.trim();
            if (!answer) return;
            onAnswer(row.id, 'approve', answer);
            setCustom('');
          }}
        >
          <Input
            type="text"
            value={custom}
            maxLength={500}
            placeholder="Type your own answer"
            aria-label="Type your own answer"
            disabled={busy || orphaned}
            onChange={(event) => setCustom(event.target.value)}
          />
        </form>
      )}
    </article>
  );
}

/**
 * The account a bot asked for, entered where the bot cannot read it.
 *
 * The details go straight to the daemon, which encrypts them and then approves
 * the card itself - so they never pass through the conversation, the approval
 * record or the model. Declining is an ordinary denial.
 */
function AccountRequestForm({ row, disabled, onDecline }: { row: ApprovalRow; disabled: boolean; onDecline: () => void }) {
  let site = '';
  try { site = String(JSON.parse(row.payload_json)?.site ?? ''); } catch { /* Invalid cards cannot open sign-in. */ }
  return <div className="grok-account-form">
    <BrowserSignIn agentId={row.agent_id} site={site} approvalId={row.id} disabled={disabled} />
    <Button kind="secondary" disabled={disabled} onClick={onDecline}>Not now</Button>
  </div>;
}
