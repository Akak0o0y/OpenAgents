import { BotSystemPanel } from './BotSystemPanel.js';
import { UI_LOCALE } from '../lib/numbers.js';
import { describeCron } from '../lib/routineSchedule.js';
/**
 * The details panel.
 *
 * One column, three views: the bot's computer and routines, its settings, and
 * the routine editor. Which one is showing is owned by the workspace, so the
 * header's back/close controls always mean the same thing.
 *
 * The screen card shows the real browser when active and the bot loop while
 * idle/connecting. Code workspace files are separate from browser availability.
 */

import { useEffect, useState } from 'react';
import { BotBrowser } from './BotBrowser.js';
import { GrokBotSettings } from './GrokBotSettings.js';
import { GrokRoutineEditor, type RoutineDraft } from './GrokRoutineEditor.js';
import { GrokFileViewer } from './GrokFileViewer.js';
import { Modal } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { type ComputerSession } from '../lib/useComputerSession.js';
import type { BotProfile } from '../lib/botProfile.js';
import { api, type RoutineRow } from '../lib/transport.js';
import type { DetailsState, Teammate } from './workspaceTypes.js';
import type { CodeThemePreference } from '../lib/preferences.js';
import { Spinner } from '@/registry/default/ui/spinner.js';
import { FormError } from './ui/FormError.js';
import { Button, IconButton } from './ui/Button.js';
import './BotWorkspace.css';

interface GrokScreenProps {
  agent: Teammate;
  details: DetailsState;
  computer: ComputerSession;
  routines: RoutineRow[];
  routinesError: string | null;
  routinesLoading: boolean;
  profileError: string | null;
  codeTheme?: CodeThemePreference;
  onOpenStudio?: () => void;
  onClose: () => void;
  onSetView: (view: DetailsState['view'], routineId?: string | null) => void;
  onUpdateProfile: (patch: Partial<BotProfile>) => void;
  onSaveAgent: (patch: {
    name?: string;
    modelId?: string;
    systemPrompt?: string;
    budgetCapUsd?: number;
  }) => Promise<void>;
  onSaveRoutine: (draft: RoutineDraft, cron: string) => Promise<void>;
  onDeleteRoutine: (routineId: string) => Promise<void>;
  onTestRunRoutine: (routineId: string) => Promise<void>;
  onSetRoutineEnabled: (routineId: string, enabled: boolean) => Promise<void>;
  onSetRoutineWebhook: (routineId: string, enabled: boolean, rotate?: boolean) => Promise<void>;
  onOpenFile?: (file: { path: string; runId?: string | null; content?: string | null; artifactUrl?: string | null }) => void;
}

export function GrokScreen({
  agent,
  details,
  computer,
  routines,
  routinesError,
  routinesLoading,
  profileError,
  codeTheme,
  onOpenStudio,
  onClose,
  onSetView,
  onUpdateProfile,
  onSaveAgent,
  onSaveRoutine,
  onDeleteRoutine,
  onTestRunRoutine,
  onSetRoutineEnabled,
  onSetRoutineWebhook,
  onOpenFile,
}: GrokScreenProps) {
  const [fullscreen, setFullscreen] = useState(false);
  // Routines held by an unconfirmed item of their own (spec 10.1). Items of deleted
  // routines hold nothing, so they never mark one. A hint for the list only: the
  // routine editor shows the items and the button that releases them.
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (details.view !== 'details') return;
    let cancelled = false;
    api.botSystem(agent.id)
      .then((system) => {
        if (!cancelled) setWaiting(new Set((system.pendingEffects ?? []).filter((item) => !item.routineDeleted).map((item) => item.routineId)));
      })
      // Leave the marker off when the system API cannot be read; the editor reports that failure.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent.id, details.view, routines]);

  if (details.view === 'file') {
    return (
      <aside className="grok-details-pane is-file-view" aria-label="File preview">
        <GrokFileViewer
          key={`${details.selectedFile?.runId ?? ''}:${details.selectedFile?.path ?? ''}`}
          file={details.selectedFile}
          agentName={agent.name}
          codeTheme={codeTheme}
          onBack={() => onSetView('details')}
          onClose={onClose}
        />
      </aside>
    );
  }

  if (details.view === 'routine') {
    const routine = details.routineId ? routines.find((r) => r.id === details.routineId) ?? null : null;
    return (
      <aside className="grok-details-pane oh-workspace-panel" aria-label="Routine editor">
        <GrokRoutineEditor
          agentId={agent.id}
          routine={routine}
          onBack={() => onSetView('details')}
          onClose={onClose}
          onSave={onSaveRoutine}
          onDelete={onDeleteRoutine}
          onTestRun={onTestRunRoutine}
          onSetEnabled={onSetRoutineEnabled}
          onSetWebhook={onSetRoutineWebhook}
        />
      </aside>
    );
  }

  if (details.view === 'settings') {
    return (
      <aside className="grok-details-pane oh-workspace-panel" aria-label="Bot settings">
        <header className="grok-panel-header">
          <IconButton onClick={() => onSetView('details')}
            aria-label="Back to details"
            title="Back to details"
          >
            <Icon name="back" />
          </IconButton>
          <h2 className="grok-panel-title">Settings</h2>
          <IconButton onClick={onClose} aria-label="Close details" title="Close details">
            <Icon name="expand" />
          </IconButton>
        </header>
        <div className="oh-bot-settings-scroll">
        <GrokBotSettings
          key={agent.id}
          agent={agent}
          connections={<BotSystemPanel key={agent.id} agentId={agent.id} settings />}
          onUpdateProfile={onUpdateProfile}
          onSaveAgent={onSaveAgent}
          profileError={profileError}
          onOpenStudio={onOpenStudio}
        />
        </div>
      </aside>
    );
  }

  return (
    <aside className="grok-details-pane oh-workspace-panel" aria-label={`${agent.name} details`}>
      <header className="grok-panel-header details">
        <span className="oh-panel-title"><Icon name="computer" size={15} /> Workspace</span>
        <IconButton onClick={() => onSetView('settings')}
          aria-label="Bot settings"
          title="Bot settings"
        >
          <Icon name="settings" />
        </IconButton>
        <IconButton onClick={onClose} aria-label="Close details" title="Close details">
          <Icon name="expand" />
        </IconButton>
      </header>

      <div className="grok-details-body">
        <div className="oh-panel-intro"><span className="oh-studio-eyebrow">{agent.name}’s workspace</span><h3>A window into the work</h3><p>Watch the screen and manage recurring tasks.</p></div>
        <BotBrowser key={`browser-${agent.id}`} agentId={agent.id} agentName={agent.name} compact onExpand={() => setFullscreen(true)} />
        {computer.files.length > 0 && <details className="oh-workspace-files"><summary>Files ({computer.files.length})</summary>{computer.files.map(file => <button type="button" key={file} onClick={() => onOpenFile?.({path: file, runId: computer.runId})}>{file}</button>)}</details>}

        <BotSystemPanel key={agent.id} agentId={agent.id} />
        <section className="grok-routines-block" aria-label="Routines">
          {routinesLoading && (
            <p className="grok-empty-note">
              <Spinner className="grok-spinner-icon" /> Loading routines…
            </p>
          )}

          {!routinesLoading && routinesError && (
            <FormError>
              {routinesError}
            </FormError>
          )}

          {!routinesLoading && !routinesError && routines.length === 0 && (
            <div className="grok-routines-empty">
              <h3>Make it a routine</h3><p>Give recurring work a schedule. Each run keeps its own result and history.</p>
              <Button kind="secondary" onClick={() => onSetView('routine', null)}>
                Create Routine
              </Button>
            </div>
          )}

          {!routinesLoading && !routinesError && routines.length > 0 && (
            <>
              <div className="grok-routines-header">
                <div><h3>Routines <span className="oh-section-count">{routines.length}</span></h3><p>Work that runs on your schedule.</p></div>
                <IconButton onClick={() => onSetView('routine', null)}
                  aria-label="Create routine"
                  title="Create routine"
                >
                  +
                </IconButton>
              </div>
              <ul className="grok-routines-list">
                {routines.map((routine) => (
                  <li key={routine.id}>
                    <button type="button" onClick={() => onSetView('routine', routine.id)}>
                      <span className="oh-routine-card-heading"><span className="grok-routine-name">{routine.name}</span><span className={`oh-routine-state ${routine.enabled?'is-active':''}`}>{routine.enabled?'Active':'Paused'}</span></span>
                      {waiting.has(routine.id) && (
                        <span className="grok-routine-waiting" title="An unconfirmed post needs checking">
                          Waiting for you
                        </span>
                      )}
                      <span className="grok-routine-schedule">
                        {routine.schedule_enabled === 0 ? (routine.webhook_token ? 'Webhook only' : 'Manual only') : routine.human_schedule ?? describeCron(routine.cron_expression)}
                        {routine.enabled ? '' : ' · paused'}
                      </span>
                      <span className="grok-routine-next">
                        {routine.enabled && routine.schedule_enabled !== 0
                          ? `Next ${new Date(routine.next_run_at).toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}`
                          : 'Not scheduled'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {fullscreen && (
        <Modal
          label={`${agent.name}'s browser`}
          className="grok-computer-fullscreen"
          onClose={() => setFullscreen(false)}
        >
          <div className="grok-computer-fullscreen-bar">
            <IconButton onClick={() => setFullscreen(false)}
              aria-label="Exit fullscreen"
              title="Exit fullscreen"
            >
              ⤡
            </IconButton>
          </div>
          <div className="grok-computer-fullscreen-body">
            <BotBrowser key={`browser-${agent.id}`} agentId={agent.id} />
          </div>
        </Modal>
      )}
    </aside>
  );
}
