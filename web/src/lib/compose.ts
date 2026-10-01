/**
 * Put a draft into a bot's composer from elsewhere in the workspace.
 *
 * The details panel offers example requests ("Every morning at 9…") instead of
 * forms. Choosing one fills the chat composer for that bot and focuses it;
 * nothing is sent until the person edits it and presses Send.
 */

export const COMPOSE_EVENT = 'openagents:compose';

export interface ComposeDetail {
  agentId: string;
  text: string;
}

export function composeInChat(agentId: string, text: string): void {
  window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { agentId, text } }));
}
