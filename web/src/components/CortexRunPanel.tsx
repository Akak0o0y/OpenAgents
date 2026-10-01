/**
 * The selected run: its event timeline, its workspace files, and operator
 * control. One panel with a sliding tab control, where there used to be a
 * drawer with three flat text tabs and a "close" button that sat over the
 * top bar.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { runLabel } from '../lib/runLabels.js';
import { useCortex } from '../store.js';
import type { BotProfile } from '../lib/botProfile.js';
import { RunTimeline } from './RunTimeline.js';
import { WorkspaceBrowser } from './WorkspaceBrowser.js';
import { ControlPanel } from './ControlPanel.js';
import { CortexPanel, Segmented, StatusPill, timeAgo } from './CortexKit.js';

export type RunTab = 'timeline' | 'workspace' | 'control';

const TABS = [
  { value: 'timeline', label: 'Timeline', icon: 'detail' },
  { value: 'workspace', label: 'Files', icon: 'file' },
  { value: 'control', label: 'Control', icon: 'power' },
] as const;

export function CortexRunPanel({
  tab,
  onTab,
  profiles,
  onOpenFleet,
  onClose,
}: {
  tab: RunTab;
  onTab: (tab: RunTab) => void;
  profiles: Record<string, BotProfile>;
  onOpenFleet: () => void;
  onClose: () => void;
}) {
  const run = useCortex((s) => s.taskRuns.find((r) => r.id === s.selectedRunId) ?? null);
  const agents = useCortex((s) => s.agents);
  const agentName = run ? agents.find((a) => a.id === run.agent_id)?.name ?? run.agent_id : null;

  return (
    <CortexPanel
      icon="detail"
      label="Run detail"
      title={run ? runLabel(run.task_name) : 'Run detail'}
      subtitle={run ? `${agentName} · started ${timeAgo(run.started_at)}` : 'No run selected'}
      actions={run ? <StatusPill status={run.status} /> : undefined}
      onClose={onClose}
    >
      <div className="cx-panel-toolbar">
        <Segmented id="run-tabs" label="Run detail view" value={tab} options={TABS} onChange={onTab} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          className="cx-panel-body"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
        >
          {tab === 'timeline' ? (
            <RunTimeline onOpenFleet={onOpenFleet} />
          ) : tab === 'workspace' ? (
            <WorkspaceBrowser />
          ) : (
            <ControlPanel profiles={profiles} />
          )}
        </motion.div>
      </AnimatePresence>
    </CortexPanel>
  );
}
