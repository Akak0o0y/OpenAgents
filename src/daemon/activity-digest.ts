import type { AgentStore } from './agent-store.js';
import type { RoutineRecord } from './db/schema.js';

export const ACTIVITY_DIGEST_TASK = 'work:activity-digest';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * DAY_MS;
const clip = (value: unknown, max = 300) => String(value ?? '').slice(0, max);

const iso = (value: number | null | undefined) => value ? new Date(value).toISOString() : null;

/**
 * Captures bounded installation activity at admission time. The model receives this immutable SQLite snapshot as
 * citeable source data; it never guesses what happened while the desktop app was off or reads host files.
 */
export function captureActivityDigest(store: AgentStore, routine: RoutineRecord, now = Date.now()) {
  const db = store.getDatabase();
  const previous = routine.last_run_at && routine.last_run_at < now ? routine.last_run_at : now - DAY_MS;
  const since = Math.max(previous, now - MAX_WINDOW_MS);
  const recent = db.prepare(`SELECT r.id,r.task_name,r.status,r.model_id,r.started_at,r.completed_at,r.actual_cost_usd,
      a.name AS agent_name
    FROM task_runs r JOIN agents a ON a.id=r.agent_id
    WHERE COALESCE(r.completed_at,r.started_at,0)>=? AND COALESCE(r.routine_id,'')<>?
    ORDER BY COALESCE(r.completed_at,r.started_at) DESC LIMIT 40`).all(since, routine.id) as Array<Record<string, unknown>>;
  const artifactPaths = db.prepare("SELECT path FROM run_artifacts WHERE task_run_id=? AND purpose='deliverable' ORDER BY path LIMIT 20");
  const runs = recent.map(row => ({
    id: clip(row.id, 120), bot: clip(row.agent_name, 120), task: clip(row.task_name, 200), status: clip(row.status, 30), model: clip(row.model_id, 200),
    startedAt: iso(row.started_at as number | null), completedAt: iso(row.completed_at as number | null),
    actualCostUsd: Number(row.actual_cost_usd), artifacts: (artifactPaths.all(String(row.id)) as Array<{ path: string }>).map(file => file.path),
  }));
  const activeRuns = db.prepare(`SELECT r.id,r.task_name,r.status,a.name AS agent_name
    FROM task_runs r JOIN agents a ON a.id=r.agent_id WHERE r.status IN ('QUEUED','RUNNING') ORDER BY r.rowid LIMIT 30`)
    .all() as Array<{ id: string; task_name: string; status: string; agent_name: string }>;
  const pendingApprovals = db.prepare(`SELECT p.id,p.kind,p.created_at,r.task_name,a.name AS agent_name
    FROM approvals p JOIN task_runs r ON r.id=p.task_run_id JOIN agents a ON a.id=p.agent_id
    WHERE p.status='PENDING' ORDER BY p.created_at LIMIT 30`).all() as Array<{ id: string; kind: string; created_at: number; task_name: string; agent_name: string }>;
  const hasMissions = !!db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='missions'").get();
  const waitingMissions = hasMissions ? db.prepare(`SELECT m.id,m.objective,m.reason,m.runs,m.max_runs,a.name AS agent_name
    FROM missions m JOIN agents a ON a.id=m.agent_id WHERE m.status='WAITING' ORDER BY m.rowid DESC LIMIT 20`).all() as Array<Record<string, unknown>> : [];
  const routineProblems = db.prepare(`SELECT id,name,last_run_status,last_run_at,enabled FROM routines
    WHERE last_run_status IS NOT NULL AND last_run_status NOT IN ('QUEUED','RUNNING','COMPLETED') ORDER BY updated_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>;
  const totals = db.prepare(`SELECT COUNT(*) AS recent,
    SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status IN ('FAILED','ABORTED','CRASHED') THEN 1 ELSE 0 END) AS failed
    FROM task_runs WHERE COALESCE(completed_at,started_at,0)>=? AND COALESCE(routine_id,'')<>?`).get(since, routine.id) as { recent: number; completed: number; failed: number };
  const activeTotal = Number((db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status IN ('QUEUED','RUNNING')").get() as { n: number }).n);
  const approvalTotal = Number((db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status='PENDING'").get() as { n: number }).n);
  const waitingTotal = hasMissions ? Number((db.prepare("SELECT COUNT(*) AS n FROM missions WHERE status='WAITING'").get() as { n: number }).n) : 0;
  const routineProblemTotal = Number((db.prepare("SELECT COUNT(*) AS n FROM routines WHERE last_run_status IS NOT NULL AND last_run_status NOT IN ('QUEUED','RUNNING','COMPLETED')").get() as { n: number }).n);
  return {
    generatedAt: new Date(now).toISOString(),
    window: { since: new Date(since).toISOString(), until: new Date(now).toISOString(), basis: routine.last_run_at ? 'since previous digest admission' : 'first digest uses the preceding 24 hours' },
    counts: { recentRuns: Number(totals.recent), completed: Number(totals.completed), failed: Number(totals.failed), active: activeTotal, pendingApprovals: approvalTotal, waitingMissions: waitingTotal, routineProblems: routineProblemTotal },
    recentRuns: runs,
    activeRuns: activeRuns.map(run => ({ id: clip(run.id, 120), bot: clip(run.agent_name, 120), task: clip(run.task_name, 200), status: clip(run.status, 30) })),
    decisionsNeeded: {
      approvals: pendingApprovals.map(item => ({ id: clip(item.id, 120), bot: clip(item.agent_name, 120), task: clip(item.task_name, 200), kind: clip(item.kind, 100), createdAt: iso(item.created_at) })),
      waitingMissions: waitingMissions.map(item => ({ id: clip(item.id, 120), bot: clip(item.agent_name, 120), objective: clip(item.objective, 500), reason: clip(item.reason, 700), runs: Number(item.runs), maxRuns: Number(item.max_runs) })),
      routineProblems: routineProblems.map(item => ({ id: clip(item.id, 120), name: clip(item.name, 200), lastRunStatus: clip(item.last_run_status, 100), lastRunAt: iso(item.last_run_at as number | null), enabled: Number(item.enabled) === 1 })),
    },
    listLimits: { recentRuns: 40, activeRuns: 30, approvals: 30, waitingMissions: 20, routineProblems: 20 },
    scope: 'Local OpenAgents SQLite task, artifact-name, mission, approval and routine metadata only. No filesystem diff, source-control history or external service was inspected.',
  };
}

export function activityDigestContext(store: AgentStore, routine: RoutineRecord, now = Date.now()) {
  const snapshot = captureActivityDigest(store, routine, now);
  return {
    request: `${routine.prompt_template}\n\nLocal activity snapshot (data):\n${JSON.stringify(snapshot)}`,
    sourceOrigin: `Configured routine instruction plus local OpenAgents activity snapshot generated from SQLite at ${snapshot.generatedAt}`,
  };
}
