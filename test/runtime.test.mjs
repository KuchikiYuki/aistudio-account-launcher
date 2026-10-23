import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { prepareRuntimeProfile } from '../src/runtime-profile.mjs';
import { browserHost, SAFE_STORAGE_KEYS, safeLog } from '../src/userscript-host.mjs';
import { RuntimeManager, validateSettings } from '../src/runtime-manager.mjs';
import { detectBrowsers } from '../src/browser.mjs';
import { inspectStudioLogin } from '../src/login-state.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const id = 'c596245f-0fee-461f-8b9b-2bf72a8a88d4';
const source = await readFile(path.join(projectRoot, 'vendor/catiecli-playground.user.js'), 'utf8');

test('creates isolated empty environments and preserves only their own session data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-independent-test-'));
  try {
    const directory = await prepareRuntimeProfile(root, { id });
    assert.ok(directory.startsWith(path.join(root, 'runtime-profiles')));
    assert.deepEqual(await readdir(path.join(directory, 'Default')), []);
    const marker = JSON.parse(await readFile(path.join(directory, 'environment.json'), 'utf8'));
    assert.equal(marker.source, 'manual-login');
    await writeFile(path.join(directory, 'Default', 'own-session'), 'local-state');
    assert.equal(await prepareRuntimeProfile(root, { id }), directory);
    assert.equal(await readFile(path.join(directory, 'Default', 'own-session'), 'utf8'), 'local-state');
    await assert.rejects(prepareRuntimeProfile(root, { id, source: { type: 'chrome-existing', directory: 'Profile 1' } }), /旧 Chrome 导入已移除/);
    const second = await prepareRuntimeProfile(root, { id: 'a1704924-9306-4563-a13f-851fefb62d2d' });
    assert.notEqual(second, directory);
    assert.deepEqual(await readdir(path.join(second, 'Default')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validates runtime settings and never persists key or authorization snapshots', () => {
  assert.equal(validateSettings({}).autoPush, false);
  assert.equal(validateSettings({ pushMinutes: 30, autoPush: false }).pushMinutes, 30);
  assert.throws(() => validateSettings({ pushMinutes: 1 }), /10–1440/);
  assert.throws(() => validateSettings({ autoHi: 'yes' }), /布尔/);
  assert.equal(SAFE_STORAGE_KEYS.has('pg_api_key'), false);
  assert.equal(SAFE_STORAGE_KEYS.has('pg_waa_snapshot'), false);
  assert.equal(safeLog('cat-fake-redaction-value'), '[Key 已隐藏]');
});

test('supervises one child per account and cancels startup and shutdown cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-manager-test-'));
  let child; let sentConfig;
  const account = { id, email: 'test@example.com', browserId: 'chrome' };
  const store = { dataDir: root, find: value => { assert.equal(value, id); return account; }, vault: { reveal: async () => 'cat-fake-test' } };
  const network = { mode: 'custom', server: 'http://127.0.0.1:10090' };
  const manager = new RuntimeManager({ store, browsers: [{ id: 'chrome', executable: 'mock' }], projectRoot, network: { snapshot: () => ({ ...network }) }, prepare: async () => root, spawn: () => {
    child = new EventEmitter(); child.pid = 123; child.connected = true; child.send = (message, callback) => { if (message.type === 'init') sentConfig = message.config; if (message.type === 'command' && message.action === 'stop') queueMicrotask(() => child.emit('exit', 0)); callback?.(); }; child.kill = () => child.emit('exit', 0); return child;
  } });
  try {
    await manager.init(); await manager.launch(id); await manager.job(id).launchPromise;
    assert.equal(manager.snapshot(id).pid, 123);
    assert.deepEqual(sentConfig.network, network);
    await assert.rejects(manager.launch(id), /已在运行/);
    child.emit('message', { type: 'storage', name: 'pg_api_key', value: 'cat-fake-should-not-persist' });
    await manager.settings(id, { autoPush: false });
    assert.equal((await readFile(manager.file, 'utf8')).includes('cat-'), false);
    await manager.stop(id); assert.equal(manager.snapshot(id).running, false); assert.equal(manager.snapshot(id).phase, 'stopped');
    assert.equal(manager.job(id).pending.size, 0);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

const fixture = `<!doctype html><html><body><a href="https://accounts.google.com" aria-label="Google Account: Test (test@example.com)">Test</a><ms-prompt-box><textarea></textarea><button aria-label="Run">Run</button></ms-prompt-box><script>
 window.__fixtureSends = 0; window.__fixturePings = 0;
 window.default_MakerSuite = { snapshot: function(service, digest) { /* .snapshot({ content yield */ return Promise.resolve('!fixture-proof'); } };
 class FixtureSocket {
   constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
   send(raw) { const msg = JSON.parse(raw); if (msg.type === 'register') setTimeout(() => this.onmessage?.({data:JSON.stringify({type:'registered'})}), 1); if (msg.type === 'ping') { window.__fixturePings++; setTimeout(() => this.onmessage?.({data:JSON.stringify({type:'pong'})}), 1); } }
   close() { this.readyState = 3; this.onclose?.({code:1000}); }
 }
 window.WebSocket = FixtureSocket;
 document.querySelector('button').onclick = () => { window.__fixtureSends++; fetch('https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent', { headers: {'x-goog-api-key':'fixture-google-key'} }).catch(() => {}); window.default_MakerSuite.snapshot({content:'fixture'}, 'digest'); };
</script></body></html>`;

test('headless Chromium executes hi, registration, idle ping/pong and scheduled cookie renewal', { timeout: 30000 }, async t => {
  const executable = (await detectBrowsers()).find(browser => browser.id === 'chrome')?.executable;
  if (!executable) return t.skip('Chrome is not installed');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-headless-test-'));
  const messages = []; const storage = []; let pushes = 0;
  const context = await chromium.launchPersistentContext(root, { executablePath: executable, channel: 'chromium', headless: true });
  try {
    await context.route('https://aistudio.google.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await context.exposeBinding('__runnerBridge', async (_source, action, payload) => {
      if (action === 'log') messages.push(payload);
      if (action === 'storage') storage.push(payload);
      if (action === 'cookies') return { cookies: ['SAPISID','__Secure-1PAPISID','__Secure-3PAPISID','__Secure-1PSID','__Secure-3PSID','SID','HSID','SSID'].map(name => ({name,value:'fixture',domain:'.google.com',path:'/',secure:true,httpOnly:true,expirationDate:-1})) };
      if (action === 'request') { pushes++; return { status: 200, responseText: JSON.stringify({cookies:8,label:'test@example.com'}) }; }
      return true;
    });
    await context.addInitScript({ content: browserHost({ key: 'cat-fake-fixture-key', storage: { pg_auto_cookie_push: true }, settings: { pushMinutes: 45 } }, source) });
    const page = context.pages()[0];
    await page.goto('https://aistudio.google.com/prompts/new_chat');
    assert.deepEqual(await page.evaluate(inspectStudioLogin), { ready: true, email: 'test@example.com' });
    await page.waitForFunction(() => window.__aistudioRunner?.status().wsStatus === 'connected');
    assert.equal(await page.evaluate(() => window.__fixtureSends), 1);
    await page.clock.install();
    await page.clock.fastForward(25000);
    await page.waitForFunction(() => window.__aistudioRunner.status().pongCount > 0);
    const firstStatus = await page.evaluate(() => window.__aistudioRunner.status());
    assert.ok(firstStatus.pingCount > 0); assert.ok(firstStatus.pongCount > 0);
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => window.__aistudioRunner.status().lastPushAt > 0);
    const afterPush = await page.evaluate(() => window.__aistudioRunner.status());
    assert.ok(pushes >= 1); assert.ok(Math.abs(afterPush.nextPushAt - afterPush.lastPushAt - 45 * 60 * 1000) < 100);
    await page.evaluate(() => window.__aistudioRunner.push());
    const manual = await page.evaluate(() => window.__aistudioRunner.status());
    assert.ok(Math.abs(manual.nextPushAt - manual.lastPushAt - 45 * 60 * 1000) < 100);
    await page.clock.fastForward(45 * 60 * 1000 + 1000);
    await page.waitForFunction(last => window.__aistudioRunner.status().lastPushAt > last, manual.lastPushAt);
    assert.ok(pushes >= 3);
    assert.ok(messages.some(line => line.includes('注册成功')));
    assert.equal(storage.some(item => item.name === 'pg_api_key' || item.name === 'pg_waa_snapshot'), false);
  } finally { await context.close(); await rm(root, { recursive: true, force: true }); }
});
