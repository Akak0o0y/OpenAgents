/**
 * A run named in words.
 *
 * Run lists showed the daemon's task names - "routine:ask",
 * "chat:thr-1789057740821-p83ff" - which say nothing to the person reading them.
 * The task name stays available as a tooltip for diagnostics.
 */

export function runLabel(taskName: string | null | undefined): string {
  const name = (taskName ?? '').trim();
  if (!name) return 'Run';
  if (name.startsWith('routine')) return 'Routine';
  if (name.startsWith('chat:')) return 'Chat';
  if (name === 'browser-login') return 'Browser sign-in';
  if (name.startsWith('mission')) return 'Mission step';
  if (name.startsWith('repository')) return 'Repository work';
  const words = name.replace(/^work:/, '').replace(/[-_:]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
