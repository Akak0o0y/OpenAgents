import type { Teammate } from './workspaceTypes.js';
import {useEffect,useState} from 'react';
import { useRunActivity } from '../lib/useRunActivity.js';
import { partialAnswerText } from '../store.js';
import { BotFace } from './BotFace.js';
import { PulseLoader } from './ui/Uiverse.js';
import { ActivityTimeline } from './ActivityTimeline.js';
import {GoalResultChecklist} from './GoalResultChecklist.js';
import {RunHumanRequests} from './RunHumanRequests.js';

export interface RunActivityCardProps {
  runId?: string | null;
  agent: Teammate;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
}

export function RunActivityCard({ runId, agent, onOpenFile }: RunActivityCardProps) {
  const { activity, attempt,events } = useRunActivity(runId);
  const [clock,setClock]=useState(Date.now());
  const terminal=['completed','failed','aborted','crashed'].includes(activity.phase);
  useEffect(()=>{if(terminal)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[terminal]);
  const start=events.find(e=>e.event_type==='TASK_STARTED'||e.event_type==='RESOURCE_WAIT')?.timestamp;
  const measurements=new Map<string,{costUsd:number|null;inputTokens:number|null;outputTokens:number|null}>();
  for(const e of events)if(e.event_type==='MODEL_MEASUREMENT'){try{const p=JSON.parse(e.payload_json);if(typeof p.callId==='string')measurements.set(p.callId,p);}catch{}}
  const usage=[...measurements.values()],known=usage.filter(m=>typeof m.costUsd==='number'&&Number.isFinite(m.costUsd));
  const steps = activity.steps;
  const hasSteps = steps.length > 0;
  const hasPlan = activity.plan.length > 0;

  // Find currently running or waiting step, if any
  const activeStep = steps.find((s) => s.status === 'running' || s.status === 'waiting');
  const latestStep = steps[steps.length - 1];
  const stepNumber = activeStep?.turn ?? latestStep?.turn ?? (hasSteps ? steps.length : undefined);
  const maxSteps = activeStep?.maxTurns ?? latestStep?.maxTurns;

  let headerText = `${agent.name} is thinking`;
  if (activeStep) {
    headerText = activeStep.label;
  } else if (hasSteps) {
    headerText = `${agent.name} is working`;
  }
  if(activity.phase==='waiting')headerText='Waiting for work resources';
  if(terminal)headerText=`Run ${activity.phase} · check result evidence below`;

  const hasReasoning = Boolean(attempt?.reasoning && attempt.reasoning.trim().length > 0);
  const hasStreamingText = Boolean(attempt?.text && attempt.text.length > 0);
  const displayAnswerText = hasStreamingText ? partialAnswerText(attempt!.text) : '';

  return (
    <div className="oh-run-activity-card" data-testid="run-activity-card">
      <div className="oh-activity-header">
        <BotFace
          size={24}
          shape={agent.profile.shape}
          color={agent.profile.color}
          eyeColor={agent.profile.eyeColor}
          image={agent.profile.avatarImage}
          emotion="30"
          idle={false}
        />
        <span className="oh-activity-title" role="status" aria-live="polite">{headerText}</span>
        <div className="oh-activity-badges">
          {activity.tokens && activity.tokens.contextWindow ? (() => {
            const usedTokens = activity.tokens.estimatedTokens ?? activity.tokens.lastInputTokens ?? 0;
            const contextWindow = activity.tokens.contextWindow;
            const pct = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)));
            const tone = pct >= 85 ? 'oh-token-danger' : pct >= 70 ? 'oh-token-warn' : '';
            const title = `Context: ${Intl.NumberFormat('en', { notation: 'compact' }).format(usedTokens)} / ${Intl.NumberFormat('en', { notation: 'compact' }).format(contextWindow)} tokens (${pct}%)`;
            return (
              <span className="oh-token-meter" data-testid="token-meter" title={title}>
                <span className="oh-token-meter-bar">
                  <span className={`oh-token-meter-fill ${tone}`} style={{ width: `${pct}%` }} />
                </span>
                <span className="oh-token-meter-text">{pct}%</span>
              </span>
            );
          })() : null}
          {stepNumber !== undefined && (
            <span className="oh-step-counter" data-testid="step-counter">
              {maxSteps ? `Step ${stepNumber} of ${maxSteps}` : `Step ${stepNumber}`}
            </span>
          )}
        </div>
        {(!hasSteps || activeStep || activity.thinkingSince || attempt) && (
          <PulseLoader label={headerText} />
        )}
      </div>

      <p>{start?`${Math.max(0,Math.floor(((terminal?events[events.length-1]?.timestamp:clock)??clock)-start)/1000)}s elapsed · `:''}{usage.length?`${usage.length} reported model calls · ${known.length?`$${known.reduce((sum,m)=>sum+m.costUsd!,0).toFixed(6)} reported cost${known.length<usage.length?' + unknown usage':''}`:'Cost unknown'}`:'Model usage not yet reported'}</p>

      {runId && !terminal && <RunHumanRequests key={`${agent.id}:${runId}`} runId={runId} agentId={agent.id} waiting={steps.some(step=>step.tool==='request_human'&&step.status==='waiting')}/>}

      {activity.todos && activity.todos.length > 0 ? (
        <details className="oh-activity-checklist" open data-testid="activity-checklist">
          <summary>
            Checklist ({activity.todos.filter((t) => t.status === 'completed').length}/{activity.todos.length} completed)
          </summary>
          <ul className="oh-checklist-items">
            {activity.todos.map((item, idx) => (
              <li key={item.id ?? idx} className={`oh-checklist-item oh-status-${item.status}`}>
                <span className="oh-checklist-icon" aria-hidden="true">
                  {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '○'}
                </span>
                <span className="oh-checklist-text">{item.text}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : hasPlan ? (
        <details className="oh-activity-plan">
          <summary>Task plan ({activity.plan.length} items)</summary>
          <ol>
            {activity.plan.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ol>
        </details>
      ) : null}

      {hasReasoning && !hasStreamingText && <p role="status">Working on the next step…</p>}

      {hasStreamingText && !attempt?.abandoned && (
        <div className="oh-streaming-text" data-testid="streaming-text">
          <div className="oh-streaming-bubble">
            {displayAnswerText}
            {attempt?.phase !== 'end' && <span className="oh-streaming-cursor" />}
          </div>
        </div>
      )}

      {attempt?.abandoned && (
        <div className="oh-attempt-abandoned-notice" role="alert" data-testid="abandoned-notice">
          Streamed response discarded: model identity unverified or run aborted.
        </div>
      )}

      {hasSteps && <ActivityTimeline key={runId} steps={steps} runId={runId} onOpenFile={onOpenFile} live />}
      {runId&&<GoalResultChecklist agentId={agent.id} runId={runId}/>}
    </div>
  );
}
