// Isolated design fixture: imports production components, never connects to a daemon.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/src/tailwind.css';
import { RunActivityCard } from '../../web/src/components/RunActivityCard';
import { useCortex } from '../../web/src/store';
import { defaultProfile } from '../../web/src/lib/botProfile';
import type { Teammate } from '../../web/src/components/workspaceTypes';
import type { RunStep } from '../../src/cortex/run-steps';

const agent: Teammate = { id: 'preview', name: 'Milo', description: 'Design fixture', model: 'fixture', status: 'RUNNING', budgetCapUsd: 0,
  profile: { ...defaultProfile({ id: 'preview', name: 'Milo', model_id: 'fixture' }), color: '#b89771' },
  flags: { pinned: false, unread: false, hidden: false, section: null }, reactions: {}, threadId: null, lastMessagePreview: null, lastMessageAt: null };
const steps: RunStep[] = Array.from({ length: 60 }, (_, i) => ({ id: `step-${i}`, turn: i + 1, maxTurns: 80, tool: 'browser', label: 'Using browser', subject: 'Inspect page · drive.google.com', status: 'ok', card: 'browser', startedAt: i * 1000, endedAt: i * 1000 + 640, output: 'Page observed. 2 image files found.' }));
Object.assign(steps[55], { tool: 'read', card: 'read', label: 'Reading files', subject: 'workspace/milo-profile/notes.md', output: '# Profile notes\nUse the approved avatar and cover image.' });
Object.assign(steps[56], { tool: 'run', card: 'terminal', label: 'Running command', subject: 'ls -lah ~/Downloads', output: 'total 2.4M\n-rw-r--r-- 1 bot bot  820K avatar.png\n-rw-r--r-- 1 bot bot  1.6M cover.png' });
Object.assign(steps[57], { status: 'error', label: 'Downloading image', subject: 'cover.png · drive.google.com', output: 'The download was interrupted. The file has not been saved.\nInspect the page before continuing.' });
Object.assign(steps[58], { label: 'Checking browser', subject: 'Refresh page state · drive.google.com' });
Object.assign(steps[59], { tool: 'run', card: 'terminal', status: 'running', endedAt: undefined, label: 'Checking downloaded files', subject: 'file ~/Downloads/avatar.png', output: 'avatar.png: PNG image data, 1024 × 1024, RGBA' });
useCortex.setState({ watchRun: () => () => {}, liveRuns: { preview: { events: [], watchers: 1, activity: { runId: 'preview', phase: 'running', plan: ['Find the approved images', 'Check the files', 'Update the profile and verify'], steps, tokens: { estimatedTokens: 18000, contextWindow: 128000 } } } } });

function Preview() {
  const [theme, setTheme] = useState('dark');
  document.documentElement.dataset.theme = theme;
  return <div style={{ height: '100%', overflow: 'auto', background: 'var(--gk-bg-transcript)', color: 'var(--gk-text)', padding: '24px clamp(12px, 4vw, 48px)' }}>
    <div style={{ maxWidth: 790, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 28 }}>
        <div><strong style={{ fontSize: 15 }}>Milo’s workspace</strong><div style={{ color: 'var(--gk-text-muted)', fontSize: 11 }}>Design preview · sample activity</div></div>
        <button style={{ background: 'var(--gk-bg-surface)', color: 'var(--gk-text)', border: '1px solid var(--gk-line)', borderRadius: 8, padding: '7px 12px' }} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Switch to {theme === 'dark' ? 'light' : 'dark'}</button>
      </header>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 28 }}><p style={{ maxWidth: '85%', background: 'var(--gk-bg-hover)', borderRadius: '16px 16px 4px 16px', padding: '13px 17px', margin: 0 }}>Find the images in Drive and prepare them for my profile.</p></div>
      <main style={{ '--oh-bot': '#b89771' } as React.CSSProperties}><RunActivityCard runId="preview" agent={agent} onOpenFile={() => {}} /></main>
      <div style={{ marginTop: 18, padding: '18px 20px', border: '1px solid var(--gk-line-strong)', borderRadius: 20, color: 'var(--gk-text-muted)', background: 'var(--gk-bg-surface)' }}>Steer Milo or queue a follow-up…</div>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
