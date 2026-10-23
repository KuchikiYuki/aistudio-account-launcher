import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError, atomicWrite } from './store.mjs';
import { prepareRuntimeProfile } from './runtime-profile.mjs';
import { SAFE_STORAGE_KEYS, safeLog } from './userscript-host.mjs';
import { NativeLogin } from './native-login.mjs';
import { DEFAULT_NETWORK } from './network.mjs';

const workerPath = fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url));
const DEFAULT_SETTINGS = { pushMinutes: 45, autoPush: false, autoHi: true, autoRestart: true };
export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  const next = { ...previous };
  for (const name of ['autoPush', 'autoHi', 'autoRestart']) if (input[name] !== undefined) {
    if (typeof input[name] !== 'boolean') throw new AppError('开关设置必须是布尔值。');
    next[name] = input[name];
  }
  if (input.pushMinutes !== undefined) {
    if (!Number.isInteger(input.pushMinutes) || input.pushMinutes < 10 || input.pushMinutes > 1440) throw new AppError('续推间隔应为 10–1440 分钟。');
    next.pushMinutes = input.pushMinutes;
  }
  return next;
}

export class RuntimeManager {
  constructor({ store, browsers, projectRoot, prepare = prepareRuntimeProfile, spawn = fork, nativeLogin = options => new NativeLogin(options), consoleOutput = null, network = { snapshot: () => ({ ...DEFAULT_NETWORK }) } }) {
    this.store = store; this.browsers = browsers; this.projectRoot = projectRoot; this.prepare = prepare; this.spawn = spawn;
    this.jobs = new Map(); this.saved = {}; this.writeQueue = Promise.resolve(); this.stopping = false;
    this.file = path.join(store.dataDir, 'runner-settings.json');
    this.nativeLogin = nativeLogin;
    this.network = network;
    this.consoleOutput = typeof consoleOutput === 'function' ? consoleOutput : null;
  }
  async init() {
    try { this.saved = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => atomicWrite(this.file, JSON.stringify(this.saved, null, 2)));
    return this.writeQueue;
  }
  job(id) {
    this.store.find(id);
    if (!this.jobs.has(id)) this.jobs.set(id, { phase: 'stopped', mode: 'headless', logs: [], child: null, pending: new Map(), retries: 0, generation: 0 });
    return this.jobs.get(id);
  }
  snapshot(id) {
    const job = this.job(id);
    const { child, pending, logs, restartTimer, launchPromise, login, ...info } = job;
    return { ...info, pid: child?.pid || (login && !login.closed ? login.child?.pid : null) || null, running: Boolean(child || launchPromise || (login && !login.closed)), pendingLogin: Boolean(login), settings: { ...DEFAULT_SETTINGS, ...this.saved[id]?.settings }, logCount: logs.length };
  }
  log(id, message) {
    const safeMessage = safeLog(message);
    const job = this.job(id);
    job.logs.push({ at: Date.now(), message: safeMessage });
    if (job.logs.length > 300) job.logs.shift();
    if (this.consoleOutput) {
      const account = this.store.find(id);
      const label = String(account.label || id).replace(/[\r\n\t]+/g, ' ').slice(0, 80);
      const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${label}] ${safeMessage}`;
      try { this.consoleOutput(line); } catch { /* Console output must not affect account control. */ }
    }
  }
  settings(id, input) {
    const previous = this.saved[id] || {};
    this.saved[id] = { ...previous, settings: validateSettings(input, { ...DEFAULT_SETTINGS, ...previous.settings }) };
    return this.persist();
  }
  async launch(id, { loginMode = false, retry = false } = {}) {
    const account = this.store.find(id);
    if (account.archived) throw new AppError('请先恢复已归档的账号。', 409);
    const job = this.job(id);
    if (job.child || job.launchPromise || (job.login && !job.login.closed)) throw new AppError('此账号已在运行或登录窗口尚未关闭。', 409);
    job.login = null;
    clearTimeout(job.restartTimer);
    if (!retry) job.retries = 0;
    const generation = ++job.generation;
    job.phase = 'preparing'; job.mode = loginMode ? 'login' : 'headless'; job.message = '';
    this.log(id, loginMode ? '准备普通浏览器登录窗口（不连接自动化调试器）' : '准备启动后台 Chromium 子进程');
    job.launchPromise = (async () => {
      let key = '';
      if (!loginMode) key = await this.store.vault.reveal(id).catch(() => this.store.vault.revealShared()).catch(() => { throw new AppError('请先保存此账号或共享 cat-key。'); });
      const browser = this.browsers.find(item => item.id === account.browserId);
      if (!browser) throw new AppError('找不到可用的 Chromium 内核。', 503);
      const profile = await this.prepare(this.store.dataDir, account);
      const network = this.network.snapshot();
      if (job.generation !== generation || this.stopping) return;
      if (loginMode) {
        const login = this.nativeLogin({ executable: browser.executable, profile, network });
        job.login = login;
        job.waaReady = false; job.bundleReady = false; job.wsStatus = 'disconnected'; job.pingCount = 0; job.pongCount = 0; job.lastPingAt = 0; job.lastPongAt = 0;
        login.on('closed', () => {
          if (job.login !== login || this.stopping) return;
          job.phase = 'login_closed';
          job.message = '普通登录窗口已关闭，登录态未验证。点击“完成登录并转后台”后检查。';
          this.log(id, '普通登录窗口已退出；会话保留在此账号目录，尚未验证登录成功');
        });
        await login.start();
        if (job.generation === generation && !login.closed) {
          job.phase = 'login_window';
          job.message = '请在普通浏览器中手动登录并进入 AI Studio，然后关闭此账号的全部登录窗口，再点击“完成登录并转后台”。';
          this.log(id, '普通登录窗口已打开：无自动化参数、无调试连接、无脚本注入、未载入 Key');
        }
        return;
      }
      const child = this.spawn(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: false, serialization: 'json' });
      job.child = child; job.phase = 'starting';
      job.waaReady = false; job.bundleReady = false; job.wsStatus = 'disconnected'; job.pingCount = 0; job.pongCount = 0; job.lastPingAt = 0; job.lastPongAt = 0; job.email = null; job.lastProbeAt = 0;
      child.on('message', message => {
        if (job.child !== child) return;
        if (message.type === 'status') Object.assign(job, message.value);
        else if (message.type === 'log') this.log(id, message.message);
        else if (message.type === 'storage' && SAFE_STORAGE_KEYS.has(message.name) && ['number', 'boolean'].includes(typeof message.value)) {
          this.saved[id] ||= {}; this.saved[id].storage ||= {}; this.saved[id].storage[message.name] = message.value; this.persist().catch(() => this.log(id, '运行偏好保存失败'));
        } else if (message.type === 'reply') {
          const pending = job.pending.get(message.id);
          if (pending) { clearTimeout(pending.timer); job.pending.delete(message.id); message.error ? pending.reject(new AppError(message.error, 409)) : pending.resolve(message.result); }
        }
      });
      const forwardOutput = (stream, prefix) => {
        if (!stream) return;
        stream.setEncoding?.('utf8');
        let buffer = '';
        stream.on('data', chunk => {
          buffer += String(chunk);
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) if (line.trim()) this.log(id, `${prefix}${line.trim()}`);
        });
        stream.on('end', () => { if (buffer.trim()) this.log(id, `${prefix}${buffer.trim()}`); });
      };
      forwardOutput(child.stdout, 'worker stdout: ');
      forwardOutput(child.stderr, 'worker stderr: ');
      child.on('error', () => { job.message = '子进程启动失败'; job.phase = 'error'; });
      child.once('exit', (code, signal) => {
        if (job.child !== child) return;
        job.child = null;
        for (const pending of job.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError('内核进程已结束。', 409)); } job.pending.clear();
        const planned = job.generation !== generation || this.stopping;
        this.log(id, `内核已结束${planned ? '（主动停止）' : `（退出码 ${code ?? signal}）`}`);
        if (planned || loginMode) { job.phase = 'stopped'; return; }
        job.phase = job.phase === 'error' ? 'error' : 'crashed';
        const settings = { ...DEFAULT_SETTINGS, ...this.saved[id]?.settings };
        if (settings.autoRestart && job.retries < 3) {
          job.retries++; const delay = Math.min(5000 * 2 ** (job.retries - 1), 30000);
          this.log(id, `${delay / 1000} 秒后尝试恢复（${job.retries}/3）`);
          job.restartTimer = setTimeout(() => this.launch(id, { retry: true }).catch(error => this.log(id, error.message)), delay);
        }
      });
      const settings = { ...DEFAULT_SETTINGS, ...this.saved[id]?.settings };
      child.send({ type: 'init', config: { projectRoot: this.projectRoot, executable: browser.executable, profile, key, email: account.email, loginMode, network, settings, storage: { ...this.saved[id]?.storage, pg_auto_cookie_push: settings.autoPush, pg_auto_activate_hi: settings.autoHi } } });
      key = '';
    })().catch(error => { if (job.generation === generation) { job.phase = 'error'; job.message = error.message; this.log(id, error.message); } }).finally(() => { job.launchPromise = null; });
    return this.snapshot(id);
  }
  async stop(id) {
    const job = this.job(id); ++job.generation; clearTimeout(job.restartTimer); job.phase = 'stopping';
    if (job.launchPromise) await job.launchPromise;
    if (job.login) {
      try { await job.login.close(); }
      catch (error) { job.phase = 'login_window'; job.message = error.message; throw error; }
      job.login = null;
    }
    const child = job.child;
    if (child) await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); }, 12000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.send({ type: 'command', action: 'stop' }, () => {});
    });
    job.phase = 'stopped'; job.wsStatus = 'disconnected'; job.waaReady = false;
    return this.snapshot(id);
  }
  command(id, action) {
    const job = this.job(id);
    if (job.login) {
      if (action === 'check-login') return Promise.resolve(job.login.checkClosed());
      throw new AppError('普通登录窗口不接受自动化操作。请完成登录并关闭该窗口，再转入后台。', 409);
    }
    if (!job.child?.connected) throw new AppError('此账号尚未运行。', 409);
    if (action !== 'preview') this.log(id, `收到控制台操作：${action}`);
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { job.pending.delete(requestId); reject(new AppError('操作超时，请查看运行日志。', 504)); }, action === 'activate' ? 130000 : 65000);
      job.pending.set(requestId, { resolve, reject, timer });
      job.child.send({ type: 'command', id: requestId, action }, error => { if (error) { clearTimeout(timer); job.pending.delete(requestId); reject(new AppError('内核通信已中断。', 409)); } });
    });
  }
  async close() { this.stopping = true; await Promise.all([...this.jobs.keys()].map(id => this.stop(id))); await this.writeQueue.catch(() => {}); }
}
