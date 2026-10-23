export const STUDIO_URL = 'https://aistudio.google.com/prompts/new_chat';

export class StudioNavigation {
  constructor({ page, report, log, now = Date.now, timeout = 60000 }) {
    this.page = page; this.report = report; this.log = log; this.now = now; this.timeout = timeout;
    this.attempts = 0; this.retryAt = 0; this.pending = null; this.stopped = false;
  }
  navigate() {
    if (this.stopped) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async load() {
    this.retryAt = 0;
    this.report({ phase: 'loading', message: '正在载入 AI Studio，检查此环境保存的登录态', navigationRetryAt: 0, waaReady: false, bundleReady: false, wsStatus: 'disconnected', lastPingAt: 0, lastPongAt: 0, pingCount: 0, pongCount: 0 });
    try {
      const response = await this.page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      if (response && response.status() >= 400) throw new Error('HTTP ' + response.status());
      this.attempts = 0;
      this.report({ navigationRetryAt: 0 });
      this.log('AI Studio 网页已载入，等待脚本激活与反代注册');
      return true;
    } catch (error) {
      if (this.stopped) return false;
      this.attempts++;
      const seconds = Math.min(15 * 2 ** Math.min(this.attempts - 1, 3), 120);
      this.retryAt = this.now() + seconds * 1000;
      const detail = String(error.message).split('\n')[0];
      this.report({ phase: 'network_error', message: `AI Studio 连接失败，${seconds} 秒后重试。请检查网络设置及本机代理是否开启。`, navigationRetryAt: this.retryAt, waaReady: false, bundleReady: false, wsStatus: 'disconnected' });
      this.log(`AI Studio 连接失败：${detail}；${seconds} 秒后重新打开目标网页`);
      return false;
    }
  }
  async tick() {
    if (this.stopped || this.pending) return true;
    if (!this.retryAt) return false;
    if (this.now() >= this.retryAt) await this.navigate();
    return true;
  }
  stop() { this.stopped = true; this.retryAt = 0; }
}
