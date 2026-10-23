import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserHost, SAFE_STORAGE_KEYS, STUDIO_ORIGIN, PUSH_URL, UPDATE_URL, safeLog } from './userscript-host.mjs';
import { backendRequest, proxyOptions, networkBrowserArgs, networkDescription } from './network.mjs';
import { StudioNavigation } from './studio-navigation.mjs';

let context;
let page;
let config;
let status = {};
let monitor;
let closing = false;
let pushing = false;
let lastBridgeStatus = 0;
let navigation;
let monitoring = false;
const report = patch => { status = { ...status, ...patch }; process.send?.({ type: 'status', value: status }); };
const log = message => process.send?.({ type: 'log', message: safeLog(message, config?.key) });
const browserOptions = (executablePath, network) => ({
  executablePath, channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  ...proxyOptions(network),
  timeout: 45000, args: [...(network?.mode === 'direct' ? networkBrowserArgs(network) : []), '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

function safeStatus(input) {
  const output = {};
  for (const name of ['bundleReady', 'waaReady', 'pushBusy', 'autoCookiePush']) output[name] = input?.[name] === true;
  for (const name of ['lastPingAt', 'lastPongAt', 'pingCount', 'pongCount', 'lastPushAt', 'nextPushAt', 'requestCount', 'queueDepth']) output[name] = Number.isFinite(input?.[name]) ? input[name] : 0;
  output.wsStatus = ['connected', 'connecting', 'disconnected'].includes(input?.wsStatus) ? input.wsStatus : 'disconnected';
  output.email = typeof input?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ? input.email.slice(0, 254) : null;
  return output;
}

export function googleCookie(cookie) {
  const domain = cookie.domain.replace(/^\./, '');
  return domain === 'google.com' || domain.endsWith('.google.com');
}

async function bridge(source, action, payload) {
  if (source.page !== page || source.frame !== page.mainFrame() || new URL(source.frame.url()).origin !== STUDIO_ORIGIN) throw new Error('页面来源不允许');
  if (action === 'log') { log(payload); return true; }
  if (action === 'storage') {
    if (!SAFE_STORAGE_KEYS.has(payload?.name) || !['number', 'boolean'].includes(typeof payload.value)) return false;
    process.send?.({ type: 'storage', name: payload.name, value: payload.value });
    return true;
  }
  if (action === 'status') {
    lastBridgeStatus = Date.now();
    const info = safeStatus(payload);
    const mismatch = info.email && config.email && info.email.toLowerCase() !== config.email.toLowerCase();
    report({ ...info, phase: mismatch ? 'account_mismatch' : info.wsStatus === 'connected' ? 'online' : info.waaReady ? 'connecting' : 'activating', lastProbeAt: Date.now(), message: mismatch ? '页面账号与账号备注不符，请先确认登录账号；云端推送已阻止。' : '' });
    return true;
  }
  if (action === 'cookies') {
    const query = payload || {};
    if (query.url) {
      const url = new URL(query.url);
      if (url.protocol !== 'https:' || !(url.hostname === 'google.com' || url.hostname.endsWith('.google.com'))) return { error: '不允许读取该域名 Cookie' };
    }
    const cookies = (await context.cookies(query.url ? [query.url] : undefined)).filter(googleCookie).filter(cookie => !query.name || cookie.name === query.name);
    return { cookies: cookies.map(cookie => ({ ...cookie, expirationDate: cookie.expires, sameSite: cookie.sameSite.toLowerCase() })) };
  }
  if (action === 'request') {
    if (payload?.url === UPDATE_URL && (!payload.method || payload.method === 'GET')) {
      return backendRequest(context.request, UPDATE_URL);
    }
    if (payload?.url !== PUSH_URL || payload.method !== 'POST') return { error: '仅允许推送到指定的 catiecli 后端' };
    const current = await page.evaluate(() => window.__aistudioRunner?.status() || null);
    if (current) await bridge(source, 'status', current);
    if (!status.waaReady || !status.email) return { error: '请先激活页面并识别当前账号邮箱，防止上传到错误账号。' };
    if (config.email && status.email.toLowerCase() !== config.email.toLowerCase()) return { error: '当前登录账号与预期账号不符，未上传 Cookie。' };
    if (pushing) return { error: '已有上传正在执行' };
    pushing = true;
    try {
      const body = JSON.parse(payload.data);
      if (!Array.isArray(body.cookies) || body.cookies.length > 500 || JSON.stringify(body).length > 1000000) return { error: '推送数据无效' };
      body.email = status.email;
      // Only cookies originating in this browser context may leave the process.
      const known = await context.cookies();
      const cookies = body.cookies.filter(cookie => googleCookie(cookie) && known.some(c => googleCookie(c) && c.name === cookie.name && c.value === cookie.value && c.domain === cookie.domain && c.path === cookie.path));
      if (cookies.length !== body.cookies.length) return { error: '拒绝不属于当前运行环境的 Cookie' };
      const response = await backendRequest(context.request, PUSH_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
        data: JSON.stringify({ email: status.email, cookies }), timeout: 30000, limit: 100000,
      });
      if (response.status >= 200 && response.status < 300) report({ lastPushAt: Date.now() });
      return response;
    } catch (error) { return { error: safeLog(error.name === 'TimeoutError' ? '云端推送超时' : error.message, config.key) }; }
    finally { pushing = false; }
  }
  return null;
}

async function start(input) {
  config = input;
  if (config.loginMode) throw new Error('手动登录必须使用普通浏览器窗口，不能通过自动化内核登录');
  report({ phase: 'starting', startedAt: Date.now(), mode: 'headless', wsStatus: 'disconnected' });
  log('连接方式：' + networkDescription(config.network));
  context = await chromium.launchPersistentContext(config.profile, browserOptions(config.executable, config.network));
  context.on('close', () => { if (!closing) { log('内核进程已结束'); process.exit(0); } });
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  for (const extra of pages.slice(1)) await extra.close();
  context.on('page', extra => { if (!config.loginMode && extra !== page) extra.close().catch(() => {}); });
  if (!config.loginMode) {
    await context.exposeBinding('__runnerBridge', bridge);
    const userscript = await readFile(path.join(config.projectRoot, 'vendor', 'catiecli-playground.user.js'), 'utf8');
    await context.addInitScript({ content: browserHost({ key: config.key, storage: config.storage, settings: config.settings }, userscript) });
  }
  report({ phase: 'loading', message: '正在无窗口载入 AI Studio，检查此环境保存的登录态' });
  log('无窗口 Chromium 已启动，正在载入 AI Studio');
  navigation = new StudioNavigation({ page, report, log });
  await navigation.navigate();
  monitor = setInterval(() => { void probe(); }, 5000);
}

async function probe() {
  if (monitoring || closing) return;
  monitoring = true;
  try {
    if (closing) return;
    if (page.isClosed()) return shutdown();
    if (await navigation.tick()) return;
    const url = new URL(page.url());
    if (url.hostname === 'accounts.google.com') {
      report({ phase: 'needs_login', lastProbeAt: Date.now(), message: '此环境尚未登录或会话已失效，请点“登录 / 更新登录”。' });
      return;
    }
    if (Date.now() - lastBridgeStatus > 20000) {
      try {
        const result = await page.evaluate(() => window.__aistudioRunner?.status() || null);
        if (result) await bridge({ page, frame: page.mainFrame() }, 'status', result);
        else report({ phase: 'page_blocked', lastProbeAt: Date.now(), message: '页面未进入可运行状态，请查看页面预览或修复登录。' });
      } catch { report({ phase: 'unresponsive', message: '页面暂时无响应，尚未确认心跳成功。' }); }
    }
  } catch { if (!closing) report({ phase: 'unresponsive', message: '页面暂时无响应，等待下次检查。' }); }
  finally { monitoring = false; }
}

async function shutdown() {
  if (closing) return;
  closing = true; clearInterval(monitor);
  navigation?.stop();
  await context?.close().catch(() => {});
  process.exit(0);
}

process.on('message', async message => {
  if (message.type === 'init') {
    try { await start(message.config); }
    catch (error) { log('启动失败：' + error.message.split('\n')[0]); report({ phase: 'error', message: safeLog(error.message.split('\n')[0], config?.key) }); await shutdown(); }
    return;
  }
  if (message.type !== 'command') return;
  try {
    let result = true;
    if (message.action === 'stop') return shutdown();
    if (message.action === 'preview') {
      if (!page || page.isClosed()) throw new Error('页面尚未启动');
      result = (await page.screenshot({ type: 'png', timeout: 10000 })).toString('base64');
    } else if (message.action === 'reload') {
      if (!navigation) throw new Error('页面尚未启动');
      lastBridgeStatus = 0;
      if (!await navigation.navigate()) throw new Error('重新载入失败，已安排自动重试，请检查网络设置。');
    }
    else if (['activate', 'reconnect', 'push'].includes(message.action)) {
      if (config.loginMode) throw new Error('请先完成登录并转入后台模式');
      if (message.action === 'activate' && status.waaReady) { log('WAA 已就绪，不重复发送 hi'); }
      else await page.evaluate(async action => {
        if (!window.__aistudioRunner) throw new Error('页面执行器尚未就绪');
        await window.__aistudioRunner[action]();
      }, message.action);
    } else throw new Error('不支持的操作');
    process.send?.({ type: 'reply', id: message.id, result });
  } catch (error) { process.send?.({ type: 'reply', id: message.id, error: safeLog(error.message.split('\n')[0], config?.key) }); }
});
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
