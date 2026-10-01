// The owner's release note for Stage 1, honest posting (spec section 15, step 3).
//
// Every fact about the first start comes from first-start-copy.json, the produced package's daemon
// on a paused copy of the owner's profile, and every fact about what the shortcuts open comes from
// identity.json. When the copy differs from what the spec expected (risk 22), the note says what the
// copy shows instead. It reads and writes files in the evidence folder only.
//
// Usage: node scripts/write-honest-posting-release-note.mjs [--date=YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const day = option('date') ?? new Date().toISOString().slice(0, 10);
const folder = path.join(repoRoot, 'docs', 'validation', `${day}-honest-posting`);
const read = name => {
  const file = path.join(folder, name);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(repoRoot, file)} is missing. Run the step that writes it first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const report = read('first-start-copy.json');
const identity = read('identity.json');
if (!report.booted || report.error || !report.first) throw new Error(`first-start-copy.json has no result from the package (${report.error ?? 'it did not start'}). Fix that and run check-publish-first-start.mjs again.`);

const RUNS = { gqw8h: 'run-1790064930008-gqw8h', wveu4: 'run-1790074518658-wveu4', yf8vs: 'run-1789974004374-yf8vs' };
const short = runId => runId.slice(runId.lastIndexOf('-') + 1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = at => { const d = new Date(at); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
const holds = start => report.expectations.find(e => e.fact.startsWith(start))?.holds === true;
const routines = report.facts.routines;
const label = (which, fallback) => routines[which] ? `${fallback} ("${routines[which].name}")` : fallback;
const items = report.first.pendingEffects;
const wveu4 = items.find(item => item.runId === RUNS.wveu4);
const yf8vs = items.find(item => item.runId === RUNS.yf8vs);
const own = id => items.filter(item => item.routineId === id && !item.routineDeleted);
const describeItem = item => `run ${short(item.runId)} of ${item.routineDeleted ? `the deleted "${item.routineName}"` : `"${item.routineName}"`} on ${when(item.at)}`;
const others = items.filter(item => item.runId !== RUNS.wveu4 && item.runId !== RUNS.yf8vs);
const policies = report.first.publishPolicies;
// What viral-life's banner lists (spec 6.7): its own items, then deleted routines' items on its policy origin or with no origin.
const viralOrigin = policies.find(p => p.routineId === routines.viral?.id)?.origin;
const banner = [...own(routines.viral?.id), ...items.filter(item => item.routineDeleted && (item.origin === undefined || item.origin === viralOrigin))];
const nameOf = id => id === routines.honest?.id ? label('honest', 'honest-tweet') : id === routines.viral?.id ? label('viral', 'viral-life') : `routine ${id}`;

const lines = [];
const add = (...text) => lines.push(...text);
add('# Honest posting: what changes when you install this version', '',
  `This version makes Milo's posts on x.com provable. It was checked on ${day}; the checks behind it, and what is still unproven, are in \`evidence.md\` in this folder.`, '',
  '## What it does', '',
  '- Every post the bot\'s browser sends to x.com is written down before it leaves the browser. A post counts only when X\'s answer, or a check of the page afterwards, proves it went out.',
  '- A routine run sends at most one post. The bot does not reuse the same text, or reply to the same post, within 7 days.',
  '- If a routine\'s earlier post was never confirmed, the routine waits for you. Its editor shows a banner in the new Posting section, and it does not run again until you check the account and press "Checked — continue". It never resumes on its own.',
  '- A routine that must post finishes COMPLETED only with a post confirmed in that same run. When there is nothing suitable to post, the run ends BLOCKED instead of COMPLETED.', '',
  '## Right after you install it', '',
  'This is what the new version showed when it was started on a paused copy of your profile. Your profile may have moved on since; the banners show what it holds on the day you install.', '');
if (!holds('this profile had not been opened')) add('- A build of this version had already started once on your profile before this check, so what you see may differ from a first start.');
if (holds('honest-tweet must post') && holds('viral-life must post')) {
  add(`- Both of Milo's routines are marked "This routine must post on x.com", because both have clicked on x.com before: ${label('honest', 'honest-tweet')} in run gqw8h and ${label('viral', 'viral-life')} in run wveu4. You can switch this off for a routine in its Posting section.`);
} else {
  add(`- Marked "This routine must post on x.com": ${policies.filter(p => p.required).map(p => `${nameOf(p.routineId)}${p.evidenceRunId ? ` (from run ${short(p.evidenceRunId)})` : ''}`).join('; ') || 'none'}. You can switch this for a routine in its Posting section.`);
}
if (holds('viral-life waits on run wveu4') && wveu4) {
  add(`- **${label('viral', 'viral-life')} waits on run wveu4.** That run clicked Post on ${when(wveu4.at)} (the editor shows it in your local time), and its result was never confirmed. It happened before OpenAgents checked posts, so only the click was recorded. viral-life does not run until you press "Checked — continue".`);
} else {
  const waiting = own(routines.viral?.id);
  add(`- **${label('viral', 'viral-life')}:** ${waiting.length ? `it waits on ${waiting.map(describeItem).join('; ')}, until you press "Checked — continue".` : 'it has nothing waiting, so it keeps running.'}`);
}
if (holds('run yf8vs of the deleted') && yf8vs) {
  add(`- **yf8vs is listed.** Run yf8vs of the deleted routine "Milo life" clicked on x.com on ${when(yf8vs.at)}, and its result was never confirmed either. It appears on both routines' banners, but it holds nothing, because its routine no longer exists.`);
} else {
  add(`- **yf8vs:** ${yf8vs ? `it is listed as ${describeItem(yf8vs)}.` : 'it is not listed on your profile any more.'}`);
}
if (holds('honest-tweet has no item of its own')) add(`- ${label('honest', 'honest-tweet')} keeps running as scheduled.`);
else add(`- ${label('honest', 'honest-tweet')} also waits: ${own(routines.honest?.id).map(describeItem).join('; ')}.`);
if (others.length) add(`- Also listed: ${others.map(describeItem).join('; ')}.`);
add('', '## What to do', '',
  `1. Open x.com as Milo and look for anything posted around ${[wveu4 && `${when(wveu4.at)} (wveu4)`, yf8vs && `${when(yf8vs.at)} (yf8vs)`, ...others.map(item => `${when(item.at)} (${short(item.runId)})`)].filter(Boolean).join(' and ') || 'the times the banners show'}.`,
  `2. Open ${label('viral', 'viral-life')}'s editor, read the banner, and press "Checked — continue" only after that check. It marks every run listed in that banner as checked${banner.length ? ` (${banner.map(item => item.routineDeleted ? `${short(item.runId)} of the deleted "${item.routineName}"` : short(item.runId)).join(', ')})` : ''}. The next viral-life run may post.`, '',
  '## What you may notice afterwards', '',
  '- Runs that used to end COMPLETED without posting, such as a saved draft or "nothing suitable today", now end FAILED or BLOCKED. That is the honest result. If a routine should be allowed to finish without posting, switch "must post" off for it.',
  '- Each run in a routine\'s history shows what happened to its post: "Posted ✓", "Posted ✓ (checked on page)", "Posted by you", "X refused", "Unconfirmed post", "Held back a second post", "Completed, no confirmed post" or "Completed, post not checked". A routine that is waiting shows "Waiting for you" in the routine list.',
  '- If you take over the browser during a routine run and post by hand, that post counts as the run\'s one post, and the bot does not post again in that run.', '',
  '## Installing', '');
const launch = identity.launchers ?? [];
if (launch.length) add(`- Your OpenAgents shortcuts open ${[...new Set(launch.map(l => `\`${l.target}\` (version ${l.displayVersion ?? 'unknown'})`))].join(' and ')}. Your profile was last opened by version ${identity.profile?.lastVersion ?? 'unknown'}.`);
add(identity.released?.version === identity.package.displayVersion
  ? `- This version shows ${identity.package.displayVersion} as its version number, like the release before it. Its build is \`${identity.package.buildIdentity}\`, which is what tells the two apart.`
  : `- This version is ${identity.package.displayVersion}, build \`${identity.package.buildIdentity}\`.`,
  '- Installing this version, publishing it or copying the installers is a separate step, and it waits for your go-ahead.', '',
  '## What is not proven yet', '',
  '- X\'s real post request and answer have never been observed. The checks are built on the expected shape, and your normal scheduled runs will show the real one. If X answers differently, posts are confirmed by checking the page instead, and when even that cannot confirm one, the routine waits for you rather than guessing.',
  '- Nothing here was tested against your real account. No test posted anything on x.com.', '');
fs.writeFileSync(path.join(folder, 'release-note.md'), lines.join('\n'));
console.log(lines.join('\n'));
console.log(`Release note: ${path.relative(repoRoot, path.join(folder, 'release-note.md'))}`);
