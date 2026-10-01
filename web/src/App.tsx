/**
 * Full-bleed layout.
 *
 * The galaxy IS the page - a fixed canvas behind everything, not a widget in a
 * bordered box. All chrome floats over it as glass: a top bar for where you are
 * and which bot sits at the centre, a dock for the panels, and a status bar
 * that says what is selected. Panels are hidden by default, so the resting
 * state of the screen is the agent's architecture and nothing else.
 *
 * One right-hand panel at a time. The dock marks the open one with a pill that
 * slides between its buttons, and the galaxy's own floating pieces - the focus
 * card, the status bar - move aside for it instead of being covered.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'framer-motion';
import { Icon, type IconName } from './components/ui/icons.js';
import { useCortex } from './store.js';
import { GalaxyCanvas } from './components/GalaxyCanvas.js';
import { FleetSidebar } from './components/FleetSidebar.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { RoutinesPanel } from './components/RoutinesPanel.js';
import { DataPanel } from './components/DataPanel.js';
import { CortexRunPanel, type RunTab } from './components/CortexRunPanel.js';
import { CortexBotSwitcher } from './components/CortexBotSwitcher.js';
import { botColor } from './components/CortexKit.js';
import { GrokWorkspace } from './components/GrokWorkspace.js';
import { DesktopChrome } from './components/DesktopChrome.js';
import { useShellInfo, useWindowState } from './lib/desktop.js';
import { api } from './lib/transport.js';
import { inkOn } from './lib/color.js';
import { defaultProfile, normaliseProfile, PROFILE_CATEGORY, PROFILE_KEY, type BotProfile } from './lib/botProfile.js';

type ViewMode = 'grok' | 'galaxy';
type Panel = 'runs' | 'chat' | 'routines' | 'data' | 'view';

/** The dock, in order. Widths live here so the galaxy's floating pieces can make room. */
const PANELS: ReadonlyArray<{ id: Panel; label: string; icon: IconName; width: number }> = [
  { id: 'runs', label: 'Run', icon: 'detail', width: 400 },
  { id: 'chat', label: 'Chat', icon: 'chat', width: 420 },
  { id: 'routines', label: 'Routines', icon: 'schedule', width: 460 },
  { id: 'data', label: 'Data', icon: 'data', width: 460 },
  { id: 'view', label: 'View', icon: 'settings', width: 340 },
];
const FLEET_WIDTH = 340;

export function App() {
  useShellInfo();
  useWindowState();

  const start = useCortex((s) => s.start);
  const error = useCortex((s) => s.error);
  const connection = useCortex((s) => s.connection);
  const agents = useCortex((s) => s.agents);
  const taskRuns = useCortex((s) => s.taskRuns);
  const selectedAgentId = useCortex((s) => s.selectedAgentId);
  const selectAgent = useCortex((s) => s.selectAgent);
  const stillView = useCortex((s) => s.view.reducedMotion);
  const activeAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const [cortexProfiles, setCortexProfiles] = useState<Record<string, BotProfile>>({});
  const [openStudioOnReturn, setOpenStudioOnReturn] = useState(false);

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('view') === 'galaxy') return 'galaxy';
    }
    return 'grok';
  });

  useEffect(() => {
    (window as any).__setViewMode = (mode: ViewMode) => setViewMode(mode);
    return () => {
      delete (window as any).__setViewMode;
    };
  }, []);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [runTab, setRunTab] = useState<RunTab>('timeline');
  const [botMenuOpen, setBotMenuOpen] = useState(false);

  useEffect(() => {
    if (viewMode !== 'galaxy') return;
    let cancelled = false;
    api.agentData(undefined, PROFILE_CATEGORY).then(({ data }) => {
      if (cancelled) return;
      const profiles: Record<string, BotProfile> = {};
      for (const agent of agents) {
        const row = data.find(item => item.agent_id === agent.id && item.key === PROFILE_KEY);
        try { profiles[agent.id] = normaliseProfile(row ? JSON.parse(row.data_json) : null, defaultProfile(agent)); }
        catch { profiles[agent.id] = defaultProfile(agent); }
      }
      setCortexProfiles(profiles);
    }).catch(() => { if (!cancelled) setCortexProfiles({}); });
    return () => { cancelled = true; };
  }, [viewMode, agents]);

  useEffect(() => start(), [start]);

  // Escape closes whatever is open, innermost first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (botMenuOpen) setBotMenuOpen(false);
      else if (panel) setPanel(null);
      else if (fleetOpen) setFleetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [botMenuOpen, panel, fleetOpen]);

  if (viewMode === 'grok') {
    return (
      <div className="app grok-mode">
        {/* Renders nothing outside the desktop shell. */}
        <DesktopChrome />
        <GrokWorkspace initialStudioOpen={openStudioOnReturn} onToggleGalaxyView={() => { setOpenStudioOnReturn(false); setViewMode('galaxy'); }} />
      </div>
    );
  }

  const activeProfile = activeAgent ? cortexProfiles[activeAgent.id] : undefined;
  const accent = activeAgent ? botColor(activeAgent, activeProfile) : '#2C86F0';
  const panelWidth = PANELS.find((item) => item.id === panel)?.width ?? 0;
  const running = taskRuns.filter((run) => run.status === 'RUNNING').length;
  const togglePanel = (id: Panel) => setPanel((current) => (current === id ? null : id));

  return (
    <div
      className={`app cx-root ${panel ? 'has-panel' : ''} ${fleetOpen ? 'has-fleet' : ''} ${stillView ? 'is-still' : ''}`}
      style={{
        '--cx-panel-w': `${panelWidth}px`,
        '--cx-fleet-w': `${FLEET_WIDTH}px`,
        '--oh-bot': accent,
        '--oh-bot-ink': inkOn(accent),
      } as CSSProperties}
    >
      <DesktopChrome />
      <MotionConfig reducedMotion={stillView ? 'always' : 'user'}>
        <GalaxyCanvas profile={activeProfile} onOpenFleet={() => setFleetOpen(true)} />

        <header className="cx-topbar">
          <div className="cx-bar">
            <button type="button" className="cx-bar-btn cx-back" onClick={() => setViewMode('grok')} title="Back to the workspace">
              <Icon name="back" size={15} />
              <span>Workspace</span>
            </button>
            <span className="cx-bar-divider" aria-hidden="true" />
            <span className="cx-brand">
              <span className="cx-brand-mark" aria-hidden="true">
                <Icon name="cortex" size={16} motion={false} />
              </span>
              <span className="cx-brand-name">Cortex</span>
              <span className="cx-live" data-tone={connection === 'open' ? 'ok' : connection === 'connecting' ? 'warn' : 'danger'}>
                <i aria-hidden="true" />
                {connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}
              </span>
            </span>
            <span className="cx-bar-divider" aria-hidden="true" />
            <CortexBotSwitcher
              agents={agents}
              activeAgent={activeAgent}
              profiles={cortexProfiles}
              open={botMenuOpen}
              onOpenChange={setBotMenuOpen}
              onSelect={selectAgent}
              onOpenStudio={() => { setOpenStudioOnReturn(true); setViewMode('grok'); }}
            />
            <button
              type="button"
              className={`cx-bar-btn ${fleetOpen ? 'is-on' : ''}`}
              aria-pressed={fleetOpen}
              onClick={() => setFleetOpen((open) => !open)}
            >
              <Icon name="group" size={15} />
              <span className="cx-bar-label">Fleet</span>
              <span className="cx-count">{agents.length}</span>
              {running > 0 && <span className="cx-running-dot" title={`${running} running`} />}
            </button>
          </div>

          <nav className="cx-bar cx-dock" aria-label="Cortex panels">
            <LayoutGroup id="cx-dock">
              {PANELS.map((item) => {
                const on = panel === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`cx-dock-btn ${on ? 'is-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => togglePanel(item.id)}
                  >
                    {on && (
                      <motion.span
                        layoutId="cx-dock-pill"
                        className="cx-dock-pill"
                        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                      />
                    )}
                    <Icon name={item.icon} size={16} />
                    <span className="cx-dock-label">{item.label}</span>
                  </button>
                );
              })}
            </LayoutGroup>
          </nav>
        </header>

        <AnimatePresence>
          {fleetOpen && (
            <FleetSidebar
              key="fleet"
              profiles={cortexProfiles}
              onPick={() => setPanel('runs')}
              onClose={() => setFleetOpen(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {panel === 'runs' && (
            <CortexRunPanel
              key="runs"
              tab={runTab}
              onTab={setRunTab}
              profiles={cortexProfiles}
              onOpenFleet={() => setFleetOpen(true)}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === 'chat' && <ChatPanel key="chat" profiles={cortexProfiles} onClose={() => setPanel(null)} />}
          {panel === 'routines' && <RoutinesPanel key="routines" onClose={() => setPanel(null)} />}
          {panel === 'data' && <DataPanel key="data" onClose={() => setPanel(null)} />}
          {panel === 'view' && <ConfigPanel key="view" onClose={() => setPanel(null)} />}
        </AnimatePresence>

        {error && (
          <div className="cx-error" role="alert">
            <Icon name="error" size={15} motion={false} />
            <span>{error}</span>
          </div>
        )}
      </MotionConfig>
    </div>
  );
}
