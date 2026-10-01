import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startDaemon } from '../dist/src/daemon/index.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';

const out = path.resolve('docs/validation/2026-09-20-editor-theme');
fs.mkdirSync(out, {recursive:true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-editor-ui-'));
const daemon = await startDaemon({configPath:null, dbPath:path.join(profile,'state.db'), wsPort:4198, docker:false, cadenceMs:60000,
  sandbox:{orphanSweep:async()=>({reapedContainers:0,reapedVolumes:0}),workspaceVolumeName:n=>n,workspaceVolumeExists:async()=>{throw new Error('Docker intentionally unavailable');}}});
const origin = 'http://127.0.0.1:4198';
const auth = JSON.parse(fs.readFileSync(path.join(profile,'state.db.auth.json'),'utf8'));
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});
await context.addCookies([{name:'openhours_session',value:auth.token,url:origin}]);
const page = await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const original='<!doctype html>\n<html lang="en">\n<head><title>OpenAgents report</title></head>\n<body style="background:#faf9f6;color:#2c2d27;font-family:Georgia;padding:40px">\n  <h1>Your work, beautifully organized.</h1>\n  <p>Made with OpenAgents.</p>\n</body>\n</html>';
try {
  const agent=daemon.store.listAgents()[0];
  const run=daemon.store.createTaskRun({agentId:agent.id,taskName:'chat:editor-test'});
  daemon.store.startTaskRun(run.id,agent.model_id);
  const artifact=new ArtifactStore(daemon.store).save(run.id,{'report.html':original})[0];
  daemon.store.finishTaskRun(run.id,'COMPLETED','Report ready.');
  const thread=daemon.chat.createThread(agent.id);
  daemon.store.appendMessage({thread_id:thread.id,role:'user',content:'Create a short report I can edit.'});
  daemon.store.appendMessage({thread_id:thread.id,role:'assistant',content:`Your report is ready: [report.html](${artifact.downloadUrl})`,task_run_id:run.id});
  await page.goto(origin);
  await page.getByRole('button',{name:'report.html',exact:true}).waitFor({timeout:30000});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light','fresh install must ignore dark OS and start light');
  const inactiveLight = await page.evaluate(() => {
    const root = document.documentElement;
    root.classList.add('oh-desktop', 'oh-unfocused');
    root.dataset.ohFocused = 'false';
    const style = getComputedStyle(root);
    const values = {
      input: style.getPropertyValue('--gk-bg-input').trim(),
      userBubble: style.getPropertyValue('--gk-bg-bubble-user').trim(),
      line: style.getPropertyValue('--gk-line').trim(),
    };
    root.classList.remove('oh-desktop', 'oh-unfocused');
    delete root.dataset.ohFocused;
    return values;
  });
  assert.deepEqual(inactiveLight, { input: '#fffefa', userBubble: '#eceee4', line: '#e4e3dc' }, 'an unfocused light window must keep light control tokens');
  await page.waitForTimeout(800); // Let the workspace entrance animations finish before visual capture.
  await page.screenshot({path:path.join(out,'workspace-light.png'),fullPage:true});
  await page.getByRole('button',{name:'report.html',exact:true}).click();
  await page.getByRole('tab',{name:'Code',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Code editor for report.html'});
  await editor.waitFor();
  await editor.fill(original.replace('beautifully organized','ready to share'));
  await editor.press('Control+s');
  await page.getByText('Saved',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Reload file',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.grok-code-textarea')?.value.includes('ready to share'));
  const response=await context.request.get(origin+artifact.downloadUrl);
  assert.match(await response.text(),/ready to share/);
  const stale=await context.request.post(`${origin}/api/runs/${run.id}/workspace?file=report.html`,{data:{content:'stale',expectedContent:original}});
  assert.equal(stale.status(),400);
  await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await page.screenshot({path:path.join(out,'editor-openagents.png'),fullPage:true});
  await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const theme=page.getByRole('combobox',{name:'Code editor theme'});
  await theme.waitFor();
  await page.waitForTimeout(800); // Includes the staggered appearance cards.
  await page.screenshot({path:path.join(out,'settings-light.png'),fullPage:true});
  await page.setViewportSize({width:1000,height:740});
  await theme.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'settings-compact.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  for(const name of ['monokai','github-dark','one-dark','vs-light','vs-dark','openhours']) {
    await theme.selectOption(name);
    await page.waitForFunction(value=>document.documentElement.dataset.codeTheme===value,name);
    assert.ok(await page.locator(`.oh-editor-theme-sample.theme-${name}`).count());
  }
  await theme.selectOption('monokai');
  await page.getByRole('radio',{name:'OpenAgents Dark',exact:true}).click();
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:'report.html',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(await page.locator('html').getAttribute('data-code-theme'),'monokai');
  await page.getByRole('button',{name:'report.html',exact:true}).click();
  await page.getByRole('tab',{name:'Code',exact:true}).click();
  await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await page.screenshot({path:path.join(out,'editor-monokai.png'),fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(out,'ui.json'),JSON.stringify({passed:true,actualDaemon:true,dockerUnavailable:true,defaultLightOnDarkOS:true,saveReloadDownload:true,staleSaveRejected:true,editorThemes:6,preferencesSurviveReload:true,errors},null,2));
  console.log('EDITOR_THEME_PASSED');
} finally { await browser.close(); await daemon.shutdown(); }
