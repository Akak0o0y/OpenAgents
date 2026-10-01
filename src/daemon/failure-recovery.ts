/**
 * What to tell a model whose actions keep failing.
 *
 * The runtime used to stop after three consecutive failures with "Review the recorded
 * tool results" - a sentence addressed to the operator, not to the model. The model was
 * never given a turn in which it was told what kept failing, so it repeated the same
 * broken action until the run was killed. Observed in practice: eight identical
 * "did not contain one complete JSON action object" failures in a row, because nothing
 * ever said that a sixty-line script does not survive being embedded in JSON.
 *
 * So a run now gets one recovery turn before it is abandoned, and that turn names the
 * obstacle and a concrete way around it.
 */

/** Routes out of failures that have actually happened, matched on the error text. */
const ROUTES: { pattern: RegExp; advice: string }[] = [
  {
    pattern: /one complete JSON action object|more than one JSON object/i,
    advice: 'Your reply was not one JSON action object. A long multi-line command is the usual cause: its newlines and quotes break the JSON. Write the script to a file with {"tool":"desktop_files","operation":"write","path":"script.py","content":"..."} and then run it with {"tool":"desktop_run","command":"python3 script.py"}.',
  },
  {
    pattern: /Browser target is missing|fresh snapshot|fresh browser snapshot/i,
    advice: 'A browser reference stopped matching the page, which happens whenever the page re-renders. Take a fresh {"tool":"browser","action":"snapshot"} and use a ref from that snapshot, never one from an earlier turn.',
  },
  {
    pattern: /exit status 127|command not found/i,
    advice: 'That program is not installed on your computer. Check with {"tool":"desktop_run","command":"command -v NAME"} first, then install it with `pip install --user NAME` or `npm install -g NAME`. Do not hand-write a protocol client when a library exists.',
  },
  {
    pattern: /Supply file content as a string/i,
    advice: 'A desktop_files write needs "content" as a string. For bytes, pass base64 text together with "encoding":"base64".',
  },
  {
    pattern: /outside the bot home directory/i,
    advice: 'Paths are resolved inside your home directory. Use a path under it, such as "Downloads/file.png".',
  },
  {
    pattern: /outcome is uncertain/i,
    advice: 'An action may have taken effect before it failed. Observe the current state first and do not repeat the submission.',
  },
  {
    pattern: /not approved|approval/i,
    advice: 'The operator did not approve that action. Ask for what you need with {"tool":"ask_user_question"} rather than retrying it.',
  },
];

function recent(errors: string[], limit = 3): string[] {
  return [...new Set(errors.filter((error) => typeof error === 'string' && error.trim()))].slice(-limit);
}

/** The one turn a failing run gets before it is abandoned. */
export function recoveryInstruction(errors: string[]): string {
  const seen = recent(errors);
  const advice = [...new Set(ROUTES.filter((route) => seen.some((error) => route.pattern.test(error))).map((route) => route.advice))];
  return [
    `Three actions in a row failed: ${seen.map((error) => JSON.stringify(error.slice(0, 200))).join('; ')}.`,
    'Repeating any of them will fail the same way.',
    ...advice,
    'Change approach now: a different tool, a smaller step, or another route to the same goal.',
    'If there is genuinely no route, say what blocks you with {"tool":"block"} or ask the operator with {"tool":"ask_user_question"}. Do not stop without doing one of those.',
  ].join(' ');
}

/**
 * Why a reply produced no action, said so the model can correct it.
 *
 * The old text - "The response did not contain one complete JSON action object." - named
 * the symptom and nothing else, so the same oversized action was sent again and again.
 */
export function parseFailureReason(content: string): string {
  const opens = (content.match(/\{/g) ?? []).length;
  const closes = (content.match(/\}/g) ?? []).length;
  if (opens === 0) {
    return 'Your reply contained no JSON action object, so nothing ran. Reply with exactly one JSON object such as {"tool":"..."} and no surrounding prose.';
  }
  if (opens > closes) {
    return 'Your reply opened a JSON action object but never closed it, so nothing ran - it was almost certainly too long. Keep the action itself small: write long scripts to a file with {"tool":"desktop_files","operation":"write","path":"script.py","content":"..."} and then run that file with {"tool":"desktop_run","command":"python3 script.py"}.';
  }
  return 'Your reply did not contain one complete JSON action object, so nothing ran. Unescaped newlines and quotes inside a long command are the usual cause: write the script to a file with {"tool":"desktop_files","operation":"write","path":"script.py","content":"..."} and run it with {"tool":"desktop_run","command":"python3 script.py"}.';
}

/** The message recorded when even the recovery turn did not help. */
export function stopMessage(errors: string[]): string {
  const seen = recent(errors);
  return seen.length === 0
    ? 'Stopped after repeated failed actions that a change of approach did not resolve.'
    : `Stopped after repeated failed actions that a change of approach did not resolve. The actions failed with: ${seen.map((error) => error.slice(0, 300)).join(' | ')}`;
}
