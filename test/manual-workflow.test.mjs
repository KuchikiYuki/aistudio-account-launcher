import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../src/server.mjs';
import { detectBrowsers } from '../src/browser.mjs';

test('console creates a manual-login environment without any Chrome import controls', { timeout: 30000 }, async t => {
  const browser = (await detectBrowsers()).find(item => item.id === 'chrome');
  if (!browser) return t.skip('Chrome is not installed');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-ui-test-'));
  const jobs = new Map();
  const actions = [];
  const runtime = {
    async init() {}, async close() {},
    snapshot(id) { return jobs.get(id) || { phase: 'stopped', running: false, mode: 'headless', settings: { pushMinutes: 45, autoPush: true, autoHi: true, autoRestart: true } }; },
    async launch(id, options) { actions.push({ id, ...options }); jobs.set(id, { phase: 'login_window', running: true, mode: 'login', pendingLogin: true }); },
    async stop() {},
    job() { return { logs: [] }; },
  };
  let app; let context;
  try {
    app = await startServer({ dataDir: root, browsers: [browser], runtime });
    context = await chromium.launchPersistentContext(path.join(root, 'ui'), { executablePath: browser.executable, channel: 'chromium', headless: true });
    const page = context.pages()[0]; const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await page.locator('#empty-state').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#import-button,#import-dialog,#empty-import').count(), 0);
    await page.locator('#empty-add').click();
    assert.equal(await page.locator('#create-login').isChecked(), true);
    await page.locator('#account-label').fill('手动登录环境');
    await page.locator('#account-email').fill('manual@example.com');
    await page.locator('#save-button').click();
    await page.getByRole('button', {name:'完成登录并转后台',exact:true}).waitFor();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].loginMode, true);
    assert.equal(app.store.data.accounts[0].email, 'manual@example.com');
    assert.equal(app.store.data.accounts[0].source, undefined);
    jobs.set(actions[0].id, { phase: 'login_closed', running: false, mode: 'login', pendingLogin: true });
    await page.locator('#refresh-button').click();
    await page.getByText('登录窗口已关 · 等待转后台', {exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:'完成登录并转后台',exact:true}).isVisible(), true);
    await page.getByRole('button', {name:'日志 / 页面预览',exact:true}).click();
    await page.locator('#runtime-dialog').waitFor({state:'visible'});
    await page.locator('[data-close="runtime-dialog"]').click();
    assert.equal(await page.locator('#runtime-dialog').isVisible(), false);
    await page.locator('#manage-network').click();
    await page.locator('#network-mode').selectOption('custom');
    await page.locator('#network-server').fill('http://127.0.0.1:10090');
    await page.locator('#network-save').click();
    await page.locator('#network-dialog').waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByText('手动登录环境', { exact: true }).waitFor();
    await page.locator('#manage-network').click();
    assert.equal(await page.locator('#network-mode').inputValue(), 'custom');
    assert.equal(await page.locator('#network-server').inputValue(), 'http://127.0.0.1:10090');
    await page.locator('.close-button[data-close="network-dialog"]').click();
    assert.deepEqual(errors, []);
  } finally {
    await context?.close(); await app?.close(); await rm(root, {recursive:true,force:true});
  }
});
