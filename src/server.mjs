import http from 'node:http';
import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AccountStore, AppError, atomicWrite } from './store.mjs';
import { detectBrowsers, openLocalPage } from './browser.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { NetworkSettings, networkDescription } from './network.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ASSETS = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };

function matchesSecret(value, token) {
  const left = Buffer.from(value || '');
  const right = Buffer.from(`Bearer ${token}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new AppError('提交内容太长。', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new AppError('提交内容格式不正确。'); }
}

export async function startServer(options = {}) {
  const dataDir = options.dataDir || path.join(PROJECT_ROOT, '.data');
  const browsers = options.browsers || await detectBrowsers();
  const store = new AccountStore(dataDir, browsers.map(browser => browser.id));
  await store.init();
  const network = new NetworkSettings(dataDir);
  await network.init();
  const token = randomBytes(32).toString('hex');
  const consoleMode = options.console === true;
  const writeConsole = line => { if (consoleMode) process.stdout.write(`${line}\n`); };
  const runtime = options.runtime || new RuntimeManager({ store, browsers, projectRoot: PROJECT_ROOT, consoleOutput: consoleMode ? writeConsole : null, network });
  await runtime.init();
  let origin;
  let statusTimer;
  const printStatus = () => {
    const accounts = store.data.accounts.filter(account => !account.archived);
    if (!accounts.length) { writeConsole(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [状态] 暂无可用账号环境`); return; }
    const running = accounts.filter(account => runtime.snapshot(account.id).running);
    const online = accounts.filter(account => runtime.snapshot(account.id).phase === 'online');
    const heartbeat = running.map(account => {
      const state = runtime.snapshot(account.id);
      return `${state.pongCount || 0}/${state.pingCount || 0}`;
    }).join(',');
    writeConsole(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [状态] 账号 ${accounts.length} · 后台运行 ${running.length} · 在线 ${online.length} · 心跳回应/发送 ${heartbeat || '无'}`);
  };
  const publicAccounts = async () => (await store.list()).map(account => ({ ...account, runtime: runtime.snapshot(account.id) }));
  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (`http://${request.headers.host}` !== origin) throw new AppError('访问地址不正确，请使用启动程序打开。', 403);
      const url = new URL(request.url, origin);
      if (request.headers.origin && request.headers.origin !== origin) {
        throw new AppError('请在本机管理页面操作。', 403);
      }
      if (request.method === 'GET' && ASSETS[url.pathname]) {
        const filename = ASSETS[url.pathname];
        response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] });
        response.end(await readFile(path.join(PUBLIC_ROOT, filename)));
        return;
      }
      if (!matchesSecret(request.headers.authorization, token)) throw new AppError('此页面已过期，请重新双击启动程序。', 401);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        send(200, { app: 'aistudio-account-launcher', version: '0.4.0', mode: 'headless-workers' }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const sharedKey = await store.vault.hasShared();
        const sharedKeyHint = sharedKey ? (await store.vault.revealShared()).slice(-4) : null;
        send(200, {
          accounts: await publicAccounts(), browsers: browsers.map(({ id, name }) => ({ id, name })),
          phase: 3, dataDir, sharedKey, sharedKeyHint, mode: 'headless-workers', network: network.snapshot(),
        }); return;
      }
      if (request.method === 'PATCH' && url.pathname === '/api/network') {
        const saved = await network.save(await bodyJson(request));
        writeConsole('[网络] 已保存：' + networkDescription(saved) + '；下次启动账号生效。');
        send(200, { network: saved }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/key') {
        const input = await bodyJson(request);
        const hint = await store.vault.saveShared(input.key);
        send(200, { sharedKey: true, sharedKeyHint: hint }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/accounts') {
        const input = await bodyJson(request);
        const created = await store.create({ label: input.label, email: input.email, browserId: input.browserId, key: input.key });
        send(201, { account: created, accounts: await publicAccounts() }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/runtime/batch') {
        const input = await bodyJson(request);
        if (!['start', 'stop'].includes(input.action)) throw new AppError('批量操作无效。');
        const results = [];
        for (const account of store.data.accounts.filter(item => !item.archived)) {
          try {
            if (input.action === 'start') { if (!runtime.snapshot(account.id).running) await runtime.launch(account.id); }
            else await runtime.stop(account.id);
            results.push({ id: account.id, ok: true });
          } catch (error) { results.push({ id: account.id, ok: false, error: error.message }); }
        }
        send(200, { results, accounts: await publicAccounts() }); return;
      }
      const runtimeMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/runtime(?:\/([a-z-]+))?$/);
      if (runtimeMatch) {
        const [, id, action] = runtimeMatch;
        store.find(id);
        if (request.method === 'GET' && action === 'logs') { send(200, { logs: runtime.job(id).logs, runtime: runtime.snapshot(id) }); return; }
        if (request.method === 'GET' && action === 'preview') {
          const png = await runtime.command(id, 'preview');
          response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(Buffer.from(png, 'base64')); return;
        }
        if (request.method === 'PATCH' && action === 'settings') {
          await runtime.settings(id, await bodyJson(request));
          send(200, { runtime: runtime.snapshot(id), accounts: await publicAccounts() }); return;
        }
        if (request.method !== 'POST') throw new AppError('操作无效。', 405);
        if (action === 'start') await runtime.launch(id);
        else if (action === 'stop') await runtime.stop(id);
        else if (action === 'restart') { await runtime.stop(id); await runtime.launch(id); }
        else if (action === 'login') { await runtime.stop(id); await runtime.launch(id, { loginMode: true }); }
        else if (action === 'finish-login') {
          const account = store.find(id);
          if (!await store.vault.exists(id) && !await store.vault.hasShared()) throw new AppError('请先保存此账号或共享 cat-key，登录窗口会保持打开。', 409);
          const login = await runtime.command(id, 'check-login');
          if (login.email && account.email && login.email.toLowerCase() !== account.email.toLowerCase()) throw new AppError('登录邮箱与账号备注不符，请先更正备注或切换账号。', 409);
          if (login.email && !account.email) await store.update(id, { email: login.email });
          await runtime.stop(id); await runtime.launch(id);
        }
        else if (action === 'clear-logs') runtime.job(id).logs.length = 0;
        else if (['activate', 'reconnect', 'push', 'reload'].includes(action)) await runtime.command(id, action);
        else throw new AppError('找不到这个运行操作。', 404);
        send(200, { runtime: runtime.snapshot(id), accounts: await publicAccounts() }); return;
      }
      const match = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (match && request.method === 'PATCH') {
        const input = await bodyJson(request);
        if (input.archived === true) await runtime.stop(match[1]);
        await store.update(match[1], { label: input.label, email: input.email, key: input.key, archived: input.archived });
        send(200, { accounts: await publicAccounts() }); return;
      }
      throw new AppError('找不到这个操作。', 404);
    } catch (error) {
      if (!response.headersSent) send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '操作未完成，原有数据已保留，请重试。' });
      else response.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (consoleMode) {
    writeConsole(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [服务] 已监听 ${origin}`);
    writeConsole('[服务] 账号内核由此窗口管理；关闭窗口或按 Ctrl+C 将停止全部内核。');
    writeConsole('[网络] ' + networkDescription(network.snapshot()));
    printStatus();
    statusTimer = setInterval(printStatus, 10000);
  }
  return {
    server, origin, token, store, runtime, url: `${origin}/#token=${token}`,
    close: async () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      await runtime.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const noOpen = process.argv.includes('--no-open');
  const portArg = process.argv.find(value => value.startsWith('--port='));
  const port = portArg ? Number(portArg.slice(7)) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const dataDir = path.join(PROJECT_ROOT, '.data');
  const runtimeFile = path.join(dataDir, 'runtime.json');
  try {
    const previous = JSON.parse(await readFile(runtimeFile, 'utf8'));
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.origin) && /^[a-f0-9]{64}$/.test(previous.token)) {
      const health = await fetch(`${previous.origin}/api/health`, { headers: { Authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(1000) }).then(response => response.json());
      if (health.app === 'aistudio-account-launcher') {
        if (!noOpen) openLocalPage(`${previous.origin}/#token=${previous.token}`);
        console.log('账号台已在运行，已复用原窗口服务。');
        return;
      }
    }
  } catch { /* A stale runtime descriptor does not affect saved accounts. */ }
  const app = await startServer({ dataDir, port, console: true });
  await atomicWrite(runtimeFile, JSON.stringify({ origin: app.origin, token: app.token, pid: process.pid }));
  console.log('[服务] 管理页面即将打开。账号与 Key 保存在本机。');
  if (!noOpen) openLocalPage(app.url);
  let stopping;
  const stop = async reason => {
    if (stopping) return stopping;
    console.log(`[服务] 收到${reason || '关闭'}信号，正在停止全部账号内核…`);
    stopping = (async () => {
      await app.close();
      await unlink(runtimeFile).catch(() => {});
      console.log('[服务] 全部账号内核与服务已停止。');
      process.exit(0);
    })();
    return stopping;
  };
  process.once('SIGINT', () => { void stop('Ctrl+C'); });
  process.once('SIGTERM', () => { void stop('终止'); });
  process.once('SIGBREAK', () => { void stop('窗口关闭'); });
  process.once('SIGHUP', () => { void stop('窗口关闭'); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const detail = error?.code === 'EADDRINUSE' ? '监听端口已被占用。请关闭旧的账号台窗口后重试。' : error?.message;
    console.error(`[错误] 账号台未能启动：${detail || '请确认数据目录可读写，并使用当前 Windows 用户运行。'}`);
    process.exitCode = 1;
  });
}
