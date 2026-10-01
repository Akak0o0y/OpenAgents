import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachDownloads, safeDownloadName } from '../src/downloads.mjs';
test('native download policy uses a save dialog and blocks untrusted contents', () => {
  const session = new EventEmitter(); const results = []; const trusted = {};
  const detach = attachDownloads(session, { isTrusted: c => c === trusted, downloadsDirectory: 'C:/Downloads', onComplete: r => results.push(r) });
  const item = new EventEmitter(); let options; item.getFilename = () => '../CON.txt'; item.setSaveDialogOptions = o => { options = o; }; item.getSavePath = () => 'selected.txt';
  let prevented = false;
  session.emit('will-download', { preventDefault: () => { prevented = true; } }, item, {}); assert.equal(prevented,true); assert.equal(options,undefined);
  session.emit('will-download', { preventDefault: () => assert.fail() }, item, trusted); assert.match(options.defaultPath, /OpenAgents-artifact.txt$/);
  item.emit('done', {}, 'cancelled'); assert.deepEqual(results,[{state:'cancelled',path:null}]);
  assert.equal(safeDownloadName('../../report.md'),'report.md'); detach(); assert.equal(session.listenerCount('will-download'),0);
});
