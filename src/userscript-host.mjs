// These are preferences, not credentials. Keys and captured authorization headers stay in memory.
export const SAFE_STORAGE_KEYS = new Set(['pg_auto_cookie_push', 'pg_auto_cookie_push_next', 'pg_auto_cookie_push_last', 'pg_auto_activate_hi', 'pg_panel_collapsed']);
export const STUDIO_ORIGIN = 'https://aistudio.google.com';
export const PUSH_URL = 'https://catiecli.sukaka.top/api/pggo/push';
export const UPDATE_URL = 'https://catiecli.sukaka.top/api/pg/script.user.js';

export function browserHost(seed, source) {
  return `(() => {
    if (location.origin !== ${JSON.stringify(seed.origin || STUDIO_ORIGIN)} || window.top !== window || !location.pathname.includes('prompts')) return;
    const data = ${JSON.stringify(seed.storage || {})};
    let key = ${JSON.stringify(seed.key || '')};
    const settings = ${JSON.stringify(seed.settings || {})};
    const safeKeys = new Set(${JSON.stringify([...SAFE_STORAGE_KEYS])});
    const rpc = (action, payload) => window.__runnerBridge(action, payload).catch(() => null);
    const unsafeWindow = window;
    const GM_getValue = (name, fallback) => name === 'pg_api_key' ? key : Object.hasOwn(data, name) ? data[name] : fallback;
    const GM_setValue = (name, value) => {
      if (name === 'pg_api_key') { key = String(value); return; }
      if (!safeKeys.has(name)) return;
      data[name] = value; rpc('storage', { name, value });
    };
    const GM_registerMenuCommand = () => {};
    const GM_openInTab = () => {};
    const GM_cookie = { list(query, callback) { rpc('cookies', query).then(value => callback(value?.cookies || [], value?.error || null)); } };
    const GM = { xmlHttpRequest(options) {
      let cancelled = false;
      rpc('request', { url: options.url, method: options.method, data: options.data }).then(response => {
        if (cancelled) return;
        if (response && !response.error) options.onload?.(response);
        else options.onerror?.({ error: response?.error || '本机通信失败' });
      });
      return { abort() { cancelled = true; } };
    } };
    const __CatieHost = {
      settings,
      log(message) { rpc('log', String(message)); },
      attach(controller) {
        Object.defineProperty(window, '__aistudioRunner', { value: controller, configurable: true });
        const report = () => rpc('status', controller.status());
        report(); setInterval(report, 5000);
      }
    };
    ${source}
  })();`;
}

export function safeLog(value, key = '') {
  let text = String(value || '').slice(0, 1500);
  if (key) text = text.replaceAll(key, '[Key 已隐藏]');
  return text.replace(/cat-[a-zA-Z0-9_-]+/g, '[Key 已隐藏]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/[A-Za-z0-9_%+\/=-]{70,}/g, '[长凭证已隐藏]');
}
