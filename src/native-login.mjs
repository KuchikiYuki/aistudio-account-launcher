import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError } from './store.mjs';
import { networkBrowserArgs } from './network.mjs';

const exec = promisify(execFile);
const closeScript = fileURLToPath(new URL('../scripts/close-login-window.ps1', import.meta.url));

// Manual authentication is a normal browser launch, not a Playwright session.
// Never add remote debugging, webdriver masking, security-policy changes or password input.
export function nativeLoginArgs(profile, url = 'https://aistudio.google.com/prompts/new_chat', network) {
  if (!path.isAbsolute(profile)) throw new AppError('独立环境目录必须是绝对路径。');
  return [
    '--user-data-dir=' + profile, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', ...networkBrowserArgs(network), '--new-window', url,
  ];
}

export class NativeLogin extends EventEmitter {
  constructor({ executable, profile, url, network, spawnBrowser = spawn, closeWindow }) {
    super();
    this.executable = executable; this.profile = profile; this.url = url;
    this.network = network;
    this.spawnBrowser = spawnBrowser;
    this.closeWindow = closeWindow || (pid => exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', closeScript, '-ProcessId', String(pid)], { windowsHide: true, timeout: 10000 }));
    this.child = null; this.closed = false; this.failed = false; this.exitCode = null;
  }
  async start() {
    if (this.child) throw new AppError('登录窗口已打开。', 409);
    const child = this.spawnBrowser(this.executable, nativeLoginArgs(this.profile, this.url, this.network), { stdio: 'ignore', windowsHide: false });
    this.child = child;
    const launched = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { this.failed = true; reject(new AppError('无法打开普通登录窗口，请检查内核是否安装。', 503)); });
    });
    child.once('exit', code => {
      this.exitCode = code; this.closed = true;
      this.emit('closed', { code });
    });
    await launched;
    return { pid: child.pid };
  }
  checkClosed() {
    if (this.failed) throw new AppError('登录窗口启动失败，请重新打开。', 409);
    if (!this.closed) throw new AppError('请先完成登录，然后正常关闭此账号的全部登录窗口，再点击“完成登录并转后台”。', 409);
    return { closed: true, email: null, loginVerified: false };
  }
  async close() {
    if (this.closed || !this.child || this.failed) return;
    if (process.platform !== 'win32') throw new AppError('请先手动关闭此账号的登录窗口。', 409);
    await this.closeWindow(this.child.pid).catch(() => { throw new AppError('请先手动关闭此账号的登录窗口；未强制终止浏览器，资料已保留。', 409); });
    if (this.closed) return;
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.removeListener('closed', done); reject(new AppError('登录窗口尚未退出，请保存页面并手动关闭后重试。', 409)); }, 8000);
      this.once('closed', done);
      if (this.closed) { this.removeListener('closed', done); done(); }
    });
  }
}
