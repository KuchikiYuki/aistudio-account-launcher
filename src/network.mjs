import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, atomicWrite } from './store.mjs';

export const DEFAULT_NETWORK = Object.freeze({ mode: 'system', server: '' });

export function validateNetwork(input) {
  if (!input || !['system', 'direct', 'custom'].includes(input.mode)) throw new AppError('请选择有效的网络模式。');
  if (input.mode !== 'custom') return { mode: input.mode, server: '' };
  if (typeof input.server !== 'string' || input.server.length > 512) throw new AppError('请填写代理地址。');
  let url;
  try { url = new URL(input.server.trim()); } catch { throw new AppError('代理地址格式不正确，例如 http://127.0.0.1:10090。'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new AppError('代理只支持 HTTP、HTTPS 或 SOCKS5 地址，不包含账号密码、路径或查询参数。');
  }
  return { mode: 'custom', server: url.origin === 'null' ? `socks5://${url.host}` : url.origin };
}

export function proxyOptions(network = DEFAULT_NETWORK) {
  const value = validateNetwork(network);
  return value.mode === 'custom' ? { proxy: { server: value.server } } : {};
}

export function networkBrowserArgs(network = DEFAULT_NETWORK) {
  const value = validateNetwork(network);
  return value.mode === 'direct' ? ['--no-proxy-server'] : value.mode === 'custom' ? ['--proxy-server=' + value.server] : [];
}

export function networkDescription(network = DEFAULT_NETWORK) {
  const value = validateNetwork(network);
  return value.mode === 'custom' ? `独立代理 ${value.server}` : value.mode === 'direct' ? '直接连接' : '跟随系统代理';
}

export class NetworkSettings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'network-settings.json');
    this.value = { ...DEFAULT_NETWORK };
    this.writeQueue = Promise.resolve();
  }
  async init() {
    try { this.value = validateNetwork(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new AppError('网络设置无法读取，请检查 network-settings.json。', 503); }
  }
  snapshot() { return { ...this.value }; }
  async save(input) {
    const next = validateNetwork(input);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.value = next;
    });
    await this.writeQueue;
    return this.snapshot();
  }
}

// Use the browser context's proxy for GM requests as well as pages/WebSockets.
// Redirects must never carry credentials to another endpoint.
export async function backendRequest(request, url, { method = 'GET', headers, data, timeout = 15000, limit = 200000 } = {}) {
  const response = await request.fetch(url, { method, headers, data, timeout, maxRedirects: 0 });
  try {
    const status = response.status();
    if (status >= 300 && status < 400) throw new Error('后端发生重定向，已阻止继续请求');
    const responseText = await response.text();
    if (responseText.length > limit) throw new Error('后端响应过大');
    return { status, responseText };
  } finally { await response.dispose(); }
}
