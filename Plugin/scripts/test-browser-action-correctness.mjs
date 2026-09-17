#!/usr/bin/env node
// Focused regression: real extension background/content in an isolated Chrome profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserControlRuntime } from '../src/background/browserControlRuntime.js';
import { buildBrowserPolicyDecision } from '../src/background/browserPolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createBrowserControlRuntime();
await runtime.startSession('probe', 'turn');
const signal = await runtime.startRequest('probe');
await runtime.stopSession('probe');
assert.equal(signal.aborted, true);
await runtime.startSession('probe', 'next');
const next = await runtime.startRequest('probe');
assert.equal((await runtime.finishRequest('probe', { signal })).stale, true);
assert.equal(next.aborted, false);
await runtime.stopSession('probe');
const action = { type: 'page.click', effect: 'publish', text: '发布', sessionId: 's', tabId: 1, requestId: 'r', currentUrl: 'http://localhost/' };
assert.equal(buildBrowserPolicyDecision(action).allowed, false);
const token = { approved: true, scope: 'state_changing', actionType: action.type, sessionId: 's', tabId: 1, requestId: 'r', expiresAt: Date.now() + 10000 };
assert.equal(buildBrowserPolicyDecision({ ...action, approvalToken: token }).allowed, true);
assert.equal(buildBrowserPolicyDecision({ ...action, approvalToken: { ...token, tabId: 2 } }).allowed, false);
assert.equal(buildBrowserPolicyDecision({ type: 'page.type', text: '如何保存图片', currentUrl: 'http://localhost/' }).allowed, true);

const chromePath = process.env.BROWSER_TEST_CHROME;
assert(chromePath, 'Set BROWSER_TEST_CHROME to Chrome for Testing; never use a personal profile.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'beav-actions-'));
const extension = path.join(root, 'dist/extension');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
const html = `<!doctype html><html><head><title>Browser regression fixture</title></head><body>
<a id="link" href="#link">继续</a><button id="button">继续</button>
<button class="duplicate">One</button><button class="duplicate">Two</button>
<input id="input" placeholder="输入"><input id="reject"><input id="password" type="password" value="never-return-this">
<input id="check" type="checkbox"><select id="select"><option value="a">A</option><option value="b">B</option></select>
<button id="stale">Stale</button><input id="cancel"><section id="long">${'content '.repeat(600)}</section>
<script>
window.receipts=[];
document.querySelector('#button').onclick=e=>window.receipts.push({target:'button',trusted:e.isTrusted});
document.querySelector('#link').onclick=()=>window.receipts.push({target:'link'});
document.querySelector('#reject').oninput=e=>e.target.value='';
document.querySelector('#input').onkeydown=e=>{if(e.key==='Enter')window.receipts.push({key:e.key,trusted:e.isTrusted})};
document.querySelector('#stale').scrollIntoView=function(){this.remove()};
</script></body></html>`;
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = spawn(chromePath, ['--headless=new', `--user-data-dir=${temp}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError = '';
browser.stderr.on('data', chunk => { browserError = (browserError + chunk.toString()).slice(-6000); });
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let deadlineTimer;
try {
  deadlineTimer = setTimeout(() => { browser.kill('SIGKILL'); }, 55000);
  let port;
  for (let i = 0; i < 200; i++) {
    try { port = (await fs.readFile(path.join(temp, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(100); }
  }
  assert(port, `Isolated browser did not start (exit=${browser.exitCode}): ${browserError}`);
  async function openPopup() {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extensionId}/popup.html`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = event => { const msg = JSON.parse(event.data); const call = pending.get(msg.id); if (call) { pending.delete(msg.id); msg.error ? call.reject(new Error(JSON.stringify(msg.error))) : call.resolve(msg.result); } };
    async function evaluate(expression) {
      const result = await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    }
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await delay(100);
      try { ready = await evaluate('document.readyState === "complete" && Boolean(chrome.runtime?.id)'); } catch { continue; }
      if (ready) break;
    }
    assert(ready, JSON.stringify({ target, extensionId, page: await evaluate('({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,500)})') }));
    return evaluate;
  }
  // The isolated browser loads the newly built package. Chrome 148 headless
  // blocks command-line extensions after runtime.reload(), so use a fresh launch.
  const evaluate = await openPopup();
  const message = payload => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
  const created = await message({ type: 'xwow-data-ai:create-browser-session', owner: 'regression' });
  assert.equal(created.success, true, JSON.stringify(created));
  const sessionId = created.session.sessionId;
  let count = 0;
  const run = action => message({ type: 'xwow-data-ai:run-browser-action', sessionId, action: { ...action, callId: `probe-${++count}` } });
  function value(result) { let v = result; for (let i = 0; i < 5; i++) { if (v.result) v = v.result; else if (v.response) v = v.response; else break; } return v; }
  function ok(result) { assert.equal(result.success, true, JSON.stringify(result)); const v = value(result); assert.notEqual(v.success, false, JSON.stringify(v)); return v; }
  const opened = ok(await run({ type: 'tab.create', url, active: true }));
  const tabId = opened.tab?.id || opened.tabId || opened.id;
  assert(tabId, JSON.stringify(opened));
  await delay(200);
  const inspect = ok(await run({ type: 'page.domSnapshot', tabId, maxChars: 1000 }));
  assert(inspect.dom_snapshot.length <= 1000);
  assert(inspect.truncated && inspect.nextCursor === 1000);
  assert(!inspect.dom_snapshot.includes('never-return-this'));
  const page2 = ok(await run({ type: 'page.domSnapshot', tabId, cursor: inspect.nextCursor, snapshotId: inspect.snapshotId, maxChars: 1000 }));
  assert.equal(page2.cursor, 1000);
  const scoped = ok(await run({ type: 'page.domSnapshot', tabId, selector: '#input' }));
  assert(scoped.dom_snapshot.includes('placeholder="输入"'));
  assert(!scoped.dom_snapshot.includes('id="link"'));
  const clicked = ok(await run({ type: 'page.click', tabId, role: 'button', text: '继续', documentId: inspect.documentId }));
  assert.equal(clicked.inputMode, 'browser');
  const read = fn => evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:${fn}}).then(r=>r[0].result)`);
  assert.deepEqual(await read('() => window.receipts'), [{ target: 'button', trusted: true }]);
  assert.equal((await run({ type: 'page.click', tabId, selector: '.duplicate' })).success, false);
  assert.equal((await run({ type: 'page.click', tabId, selector: '#button', documentId: 'old-document' })).success, false);
  ok(await run({ type: 'page.type', tabId, selector: '#input', text: '如何保存图片' }));
  const rejected = await run({ type: 'page.type', tabId, selector: '#reject', text: 'hello' });
  assert.equal(rejected.success, false);
  assert.equal(value(rejected).value, '');
  ok(await run({ type: 'input.keyboardPress', tabId, selector: '#input', key: 'Enter', documentId: inspect.documentId }));
  assert((await read('() => window.receipts')).some(r => r.key === 'Enter' && r.trusted));
  assert.equal(ok(await run({ type: 'page.setChecked', tabId, selector: '#check', checked: true })).checked, true);
  assert.equal(ok(await run({ type: 'page.select', tabId, selector: '#select', value: 'b' })).value, 'b');
  const screenshot = ok(await run({ type: 'page.screenshot', tabId }));
  assert.equal(screenshot.tabId, tabId);
  assert(screenshot.data.length > 100);
  const finalized = await run({ type: 'tabs.finalize', keep: [{ tabId, status: 'handoff' }] });
  ok(finalized);
  assert(await evaluate(`chrome.tabs.get(${tabId}).then(t=>t.id)`));
  // A user tab is released on stop rather than closed, so the actual input is observable.
  const second = await message({ type: 'xwow-data-ai:create-browser-session', owner: 'regression-cancel' });
  const secondSession = second.session.sessionId;
  const secondRun = action => message({ type: 'xwow-data-ai:run-browser-action', sessionId: secondSession, action: { ...action, callId: `probe-${++count}` } });
  assert.equal((await secondRun({ type: 'tab.claim', tabId })).success, false, 'handoff lease must remain isolated');
  const cancelTabId = await evaluate(`chrome.tabs.create({url:${JSON.stringify(url)},active:true}).then(t=>t.id)`);
  await delay(200);
  ok(await secondRun({ type: 'tab.claim', tabId: cancelTabId }));
  const pending = secondRun({ type: 'page.type', tabId: cancelTabId, selector: '#cancel', text: 'must-not-write', beforeTypeDelayMs: 1000 });
  await delay(150);
  ok(await secondRun({ type: 'turn.ended' }));
  const cancelled = await pending;
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
  assert.equal(await evaluate(`chrome.scripting.executeScript({target:{tabId:${cancelTabId}},world:'MAIN',func:()=>document.querySelector('#cancel').value}).then(r=>r[0].result)`), '');
  console.log(JSON.stringify({ ok: true, extensionLoaded: true, isolatedProfile: true, scenarios: ['cancel_signal_and_generation', 'typed_approval_bindings', 'snapshot_scope_and_pagination', 'role_target_and_trusted_click', 'ambiguous_and_stale_target_rejected', 'input_actual_readback', 'trusted_enter', 'select_and_check', 'targeted_screenshot', 'handoff_keep', 'stop_during_input_delay'] }, null, 2));
} finally {
  clearTimeout(deadlineTimer);
  for (const socket of sockets) socket.close();
  browser.kill('SIGTERM');
  await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
