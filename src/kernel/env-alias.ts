/**
 * OpenAgents was renamed from OpenHours in 0.6.0. OPENAGENTS_* is the documented form; every setting is
 * still read under its original OPENHOURS_* name, so both keep working. The new name wins.
 */
export function aliasOpenAgentsEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OPENAGENTS_') && value !== undefined) env['OPENHOURS_' + key.slice('OPENAGENTS_'.length)] = value;
  }
}
