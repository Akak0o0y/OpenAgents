import { z } from 'zod';

/** Native input acts only on the bot's isolated Linux display, never the host. */
export const computerAction = z.object({
  tool: z.literal('computer'),
  action: z.enum(['screenshot', 'click', 'double_click', 'right_click', 'middle_click', 'move', 'drag',
    'scroll', 'type', 'key', 'wait', 'clipboard', 'paste', 'windows', 'focus_window']),
  x: z.number().int().min(0).max(8191).optional(),
  y: z.number().int().min(0).max(8191).optional(),
  toX: z.number().int().min(0).max(8191).optional(),
  toY: z.number().int().min(0).max(8191).optional(),
  text: z.string().max(8000).optional(),
  // Kept identical to the container's own guard, so a key the desktop accepts is
  // never refused here and one it rejects is never sent.
  key: z.string().regex(/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Escape|Tab|space|BackSpace|Delete|Insert|Menu|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|minus|plus|equal|underscore|comma|period|slash|backslash|semicolon|colon|apostrophe|quotedbl|bracketleft|bracketright|grave|asciitilde|exclam|at|numbersign|dollar|percent|asciicircum|ampersand|asterisk|parenleft|parenright)$/).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(1).max(20).optional(),
  ms: z.number().int().min(50).max(10000).optional(),
  window: z.string().regex(/^0x[0-9a-fA-F]{1,16}$/).optional(),
}).strict();
export type ComputerAction = z.infer<typeof computerAction>;

/**
 * The bot's own computer. Every one of these runs inside the bot's container as the
 * unprivileged `bot` user: never the operator's machine, never the coding container.
 */
export const desktopRunAction = z.object({
  tool: z.literal('desktop_run'),
  command: z.string().min(1).max(8000),
  /** Relative to the bot's home; anything resolving outside it is refused. */
  cwd: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
}).strict();
export type DesktopRunAction = z.infer<typeof desktopRunAction>;

export const desktopFilesAction = z.object({
  tool: z.literal('desktop_files'),
  operation: z.enum(['list', 'read', 'write', 'mkdir', 'move', 'remove']),
  path: z.string().min(1).max(4096),
  to: z.string().max(4096).optional(),
  content: z.string().max(6_000_000).optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  /** Removing a directory needs this, so a stray path cannot erase a tree by accident. */
  recursive: z.boolean().optional(),
}).strict();
export type DesktopFilesAction = z.infer<typeof desktopFilesAction>;

/**
 * Work the bot starts and returns to later.
 *
 * `desktop_run` waits for its command and kills it at five minutes, so anything outliving
 * one step - a server, a long download, a render, a recording running while other work
 * happens - had no way to exist.
 */
export const desktopJobsAction = z.object({
  tool: z.literal('desktop_jobs'),
  operation: z.enum(['start', 'list', 'output', 'stop']),
  command: z.string().max(8000).optional(),
  cwd: z.string().max(4096).optional(),
  jobId: z.string().max(16).optional(),
}).strict();
export type DesktopJobsAction = z.infer<typeof desktopJobsAction>;

/** Record the bot's own screen while it works. The file lands in its Videos folder and
 * can then be attached to a page with browser upload and desktopPath. */
export const desktopRecordAction = z.object({
  tool: z.literal('desktop_record'),
  operation: z.enum(['start', 'stop', 'status']),
  maxSeconds: z.number().int().min(5).max(900).optional(),
  fps: z.number().int().min(1).max(30).optional(),
  /** Capture what the machine is playing as well as what is on screen. Refused outright
   * when the desktop has no sound device, rather than yielding a silent file. */
  audio: z.boolean().optional(),
}).strict();
export type DesktopRecordAction = z.infer<typeof desktopRecordAction>;

/**
 * Read the text on the bot's own screen, rather than guessing at it from an image.
 *
 * A region is strongly preferred: the whole desktop OCRs into noise, while a button, a
 * field or a code reads cleanly.
 */
export const desktopReadScreenAction = z.object({
  tool: z.literal('desktop_read_screen'),
  x: z.number().int().min(0).max(8191).optional(),
  y: z.number().int().min(0).max(8191).optional(),
  width: z.number().int().min(8).max(8192).optional(),
  height: z.number().int().min(8).max(8192).optional(),
}).strict();
export type DesktopReadScreenAction = z.infer<typeof desktopReadScreenAction>;

/** The size of the bot's own screen. Sites lay out differently at different widths, and
 * a bot that cannot resize cannot see what a person on a narrower screen sees. */
export const desktopDisplayAction = z.object({
  tool: z.literal('desktop_display'),
  operation: z.enum(['get', 'set']),
  width: z.number().int().min(640).max(3840).optional(),
  height: z.number().int().min(640).max(3840).optional(),
}).strict();
export type DesktopDisplayAction = z.infer<typeof desktopDisplayAction>;

export const desktopOpenAction = z.object({
  tool: z.literal('desktop_open'),
  app: z.enum(['files', 'terminal', 'editor', 'images', 'archives', 'chrome']).optional(),
  open: z.string().max(4096).optional(),
}).strict();
export type DesktopOpenAction = z.infer<typeof desktopOpenAction>;
