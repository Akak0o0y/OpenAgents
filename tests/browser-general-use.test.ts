import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore, MAX_BROWSER_DOWNLOAD_BYTES } from '../src/daemon/artifacts.js';
import { BrowserTools, browserAction } from '../src/daemon/browser-tools.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';

test('general browser controls, iframe references, stale-target recovery and binary file transfer', { timeout: 90000 }, async () => {
  const image = Buffer.alloc(1536 * 1024, 7);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  const frameServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<button onclick="this.textContent=\'Cross origin clicked\'">Cross origin control</button>');
  });
  frameServer.listen(0, '127.0.0.1'); await once(frameServer, 'listening');
  const frameOrigin = `http://127.0.0.1:${(frameServer.address() as { port: number }).port}`;
  const server = http.createServer((req, res) => {
    if (req.url === '/image') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="avatar.png"' }); res.end(image); return; }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="large.bin"' }); res.end(Buffer.alloc(MAX_BROWSER_DOWNLOAD_BYTES + 1)); return; }
    if (req.url === '/empty') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="empty-image.png"' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') { res.end('<button onclick="this.textContent=\'Frame clicked\'">Inside frame</button>'); return; }
    res.end(`<title>General interaction fixture</title>
      <div role="grid"><div role="row"><div role="gridcell" tabindex="0" ondblclick="this.textContent='Opened file'">A file</div></div></div>
      <label>Choice<select onchange="document.querySelector('output').textContent=this.value"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
      <label>Enabled<input type="checkbox"></label><input type="file" hidden accept="image/png" onchange="document.querySelector('output').textContent=this.files[0].type+':'+this.files[0].size">
      <button onclick="document.querySelector('input[type=file]').click()">Choose image</button>
      <button oncontextmenu="event.preventDefault();document.querySelector('output').textContent='Context opened'">Context menu</button>
      <button onclick="this.textContent='Pressed'">Keyboard control</button>
      <a href="/image">Image download</a><a href="/large">Oversized download</a><a href="/empty">Empty download</a><output></output><iframe src="/frame"></iframe><iframe src="${frameOrigin}"></iframe>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new AgentStore(':memory:'), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store);
  for (const id of ['alpha', 'beta']) store.createAgent({ id, name: id, model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'fixture' }); store.startTaskRun(run.id, 'claude-haiku-4-5');
  const other = store.createTaskRun({ agentId: 'beta', taskName: 'fixture' });
  const foreign = artifacts.save(other.id, { 'foreign.txt': 'private to beta' })[0];
  const browser = new BrowserTools({ store, artifacts, approvals, secrets: new MemorySecretStore(), previewOrigins: [origin, frameOrigin] });
  const decide = setInterval(() => { for (const pending of store.listApprovals({ pendingOnly: true })) approvals.decide(pending.id, 'APPROVED', 'Fixture'); }, 10);
  const call = (action: object) => browser.call('alpha', run.id, browserAction.parse({ tool: 'browser', ...action }), new AbortController().signal);
  const starts = () => store.getTaskEvents(run.id).filter(event => event.event_type === 'EXTERNAL_ACTION_STARTED').length;
  try {
    let page = await call({ action: 'navigate', url: origin });
    const ref = page.snapshot.match(/gridcell "A file" \[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(ref, page.snapshot);
    page = await call({ action: 'double_click', target: { ref } });
    assert.match(page.snapshot, /Opened file/);
    const frameRef = page.snapshot.match(/button "Inside frame" \[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(frameRef, page.snapshot);
    page = await call({ action: 'click', target: { ref: frameRef } });
    assert.match(page.snapshot, /Frame clicked/);
    const crossRef = page.snapshot.match(/button "Cross origin control" \[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(crossRef, page.snapshot);
    page = await call({ action: 'click', target: { ref: crossRef } });
    assert.match(page.snapshot, /Cross origin clicked/);
    assert.deepEqual(new Set(store.listApprovals({}).map(row => JSON.parse(row.payload_json).origin)), new Set([origin, frameOrigin]), 'iframe control uses its own origin grant');
    const before = starts();
    await assert.rejects(call({ action: 'click', target: { role: 'link', name: 'Missing link' } }), /no interaction was dispatched/);
    await assert.rejects(call({ action: 'click', target: { ref: 'e999999' } }), /fresh snapshot/);
    await assert.rejects(call({ action: 'fill', target: { role: 'textbox', name: 'Absent' } }), /Supply a value/);
    await assert.rejects(call({ action: 'upload', target: { role: 'file', name: '' }, sourceRunId: other.id, artifactId: foreign.id }), /owned by this bot/);
    assert.equal(starts(), before, 'invalid actions have no external intent');
    page = await call({ action: 'select', target: { role: 'combobox', name: 'Choice' }, value: 'b' });
    assert.match(page.snapshot, /Beta.*selected/);
    page = await call({ action: 'check', target: { role: 'checkbox', name: 'Enabled' }, checked: true });
    assert.match(page.snapshot, /checkbox "Enabled" \[checked\]/);
    page = await call({ action: 'right_click', target: { role: 'button', name: 'Context menu' } });
    assert.match(page.snapshot, /Context opened/);
    page = await call({ action: 'press', target: { role: 'button', name: 'Keyboard control' }, key: 'Enter' });
    assert.match(page.snapshot, /Pressed/);
    const downloaded = await call({ action: 'download', target: { role: 'link', name: 'Image download' } });
    assert.equal(downloaded.artifact?.sha256, createHash('sha256').update(image).digest('hex'));
    assert.equal(downloaded.fileInputs[0].accept, 'image/png');
    for (const target of [{ role: 'file', name: '', index: 0 }, { role: 'button', name: 'Choose image' }]) {
      page = await call({ action: 'upload', target, artifactId: downloaded.artifact!.id, sourceRunId: run.id });
      assert.match(page.snapshot, /image\/png:1572864/);
    }
    assert.equal(artifacts.list(run.id).length, 0, 'downloads are not verified deliverables');
    await assert.rejects(call({ action: 'download', target: { role: 'link', name: 'Oversized download' } }), /Download exceeds 8 MiB/);
    await assert.rejects(call({ action: 'download', target: { role: 'link', name: 'Empty download' } }), /no bytes/i, 'a download that transfers no bytes must fail loudly, not save an empty file');
    assert.equal(artifacts.list(run.id).filter(a => a.path.includes('empty-image')).length, 0, 'no empty artifact is retained');
    assert.equal(store.getTaskEvents(run.id).filter(event => event.event_type === 'EXTERNAL_ACTION_FINISHED').length, starts());
    await call({ action: 'snapshot' });
  } finally {
    clearInterval(decide); await browser.stop(); store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    frameServer.closeAllConnections(); await new Promise<void>(resolve => frameServer.close(() => resolve()));
  }
});
