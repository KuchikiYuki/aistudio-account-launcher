const $ = selector => document.querySelector(selector);
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  sessionStorage.setItem('aistudio-token', fragment.get('token'));
  history.replaceState(null, '', '/');
}
const token = sessionStorage.getItem('aistudio-token') || '';
let state = { accounts: [], browsers: [], sharedKey: false };
let toastTimer;
let refreshPending = false;
let detailAccount = null;
let previewUrl = null;
const PHASES = { stopped: '已停止', stopping: '正在停止', preparing: '准备会话', starting: '内核启动中', loading: '载入页面', network_error: '连接失败 · 等待重试', activating: '等待 hi 激活', connecting: '等待反代注册', online: '反代已注册', needs_login: '需要修复登录', login_window: '普通窗口 · 等待手动登录', login_closed: '登录窗口已关 · 等待转后台', page_blocked: '页面尚未就绪', account_mismatch: '账号不匹配', unresponsive: '页面无响应', crashed: '内核意外退出', error: '启动未完成' };
const when = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '尚无';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
  return result;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function notice(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
}

async function busy(button, operation, pending = '请稍候…') {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pending;
  try { return await operation(); }
  finally { button.disabled = false; button.textContent = original; }
}

function action(label, className, handler) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    try { await busy(button, () => handler(button)); }
    catch (error) { toast(error.message); }
  });
  return button;
}

function card(account, index) {
  const article = el('article', 'account-card');
  article.dataset.accountId = account.id;
  const head = el('div', 'account-card-heading');
  const avatar = el('div', `avatar color-${index % 4}`, account.label.slice(0, 1).toUpperCase());
  const title = el('div', 'account-identity');
  title.append(el('h3', '', account.label), el('p', '', account.email || '尚未填写邮箱备注'));
  head.append(avatar, title, el('span', 'origin-tag', account.archived ? '已归档' : '独立环境'));
  const keyRow = el('div', 'key-row');
  keyRow.append(el('span', `status-dot ${account.hasKey ? 'saved' : ''}`), el('span', '', account.hasKey ? `Key 已加密备份 · 尾号 ${account.keyHint}` : '尚未保存 Key'));
  const runtime = account.runtime || { phase: 'stopped', running: false };
  const description = el('p', 'account-description', '独立目录保存登录态。首次请手动登录，完成后切回后台运行。');
  const running = el('div', `runtime-state ${runtime.phase === 'online' ? 'is-online' : ''}`);
  running.append(el('strong', '', PHASES[runtime.phase] || runtime.phase), el('span', '', runtime.running ? (runtime.mode === 'login' ? '临时可见 · 手动登录' : '无窗口 · Chromium') : '未运行'));
  const metrics = el('div', 'runtime-metrics');
  const heartbeat = runtime.lastPongAt ? `${Date.now() - runtime.lastPongAt > 65000 ? '⚠ 回应已过期 · ' : ''}${when(runtime.lastPongAt)}（${runtime.pongCount || 0} 次）` : runtime.lastPingAt ? '已发 ping，尚未收到 pong' : '未发送';
  for (const [label, value] of [['WAA', runtime.waaReady ? '已激活' : '未激活'], ['心跳回应', heartbeat], ['最近推送', when(runtime.lastPushAt)], ['下次续推', runtime.running && runtime.autoCookiePush ? when(runtime.nextPushAt) : '未排期']]) {
    const item = el('div'); item.append(el('span', '', label), el('strong', '', value)); metrics.append(item);
  }
  if (runtime.message) metrics.append(el('p', 'runtime-message', runtime.message));
  const actions = el('div', 'card-actions');
  if (!account.archived) {
    actions.append(runtime.running ? action('停止', 'button secondary', () => runtimeAction(account, 'stop')) : action('后台启动', 'button primary open-account', () => runtimeAction(account, 'start')));
    if ((runtime.running && runtime.mode === 'login') || runtime.pendingLogin) actions.append(action('完成登录并转后台', 'button primary open-account', () => runtimeAction(account, 'finish-login')));
    if (runtime.running && runtime.mode !== 'login') actions.append(action('重启内核', 'button secondary', () => runtimeAction(account, 'restart')));
    if (runtime.mode !== 'login' || !runtime.running) actions.append(action('登录 / 更新登录', 'button secondary', () => runtimeAction(account, 'login')));
    actions.append(action('日志 / 页面预览', 'button secondary', () => showDetails(account)));
  }
  if (account.archived) actions.append(action('恢复账号', 'button secondary', () => archiveAccount(account, false)));
  const setup = el('details', 'setup-details');
  setup.append(el('summary', '', '激活、推送与账号设置'));
  const setupActions = el('div', 'setup-actions');
  if (!account.archived) {
    for (const [label, cmd] of [['发送 hi 激活', 'activate'], ['重连反代', 'reconnect'], ['立即推送云端', 'push']]) setupActions.append(action(label, 'text-button', () => runtimeAction(account, cmd)));
    setupActions.append(action('运行设置', 'text-button', () => editSettings(account)));
  }
  setupActions.append(action('编辑账号 / Key', 'text-button', () => editAccount(account)));
  if (!account.archived) setupActions.append(action('归档账号', 'text-button muted', () => archiveAccount(account, true)));
  setup.append(setupActions);
  if (account.lastOpenedAt) setup.append(el('p', 'last-opened', `上次打开：${new Date(account.lastOpenedAt).toLocaleString('zh-CN')}`));
  article.append(head, keyRow, description, running, metrics, actions, setup);
  return article;
}

function render() {
  const active = state.accounts.filter(account => !account.archived);
  const visible = state.accounts.filter(account => !account.archived || $('#show-archived').checked);
  $('#account-count').textContent = active.length;
  $('#reuse-count').textContent = active.filter(account => account.runtime?.running && account.runtime?.mode !== 'login').length;
  $('#key-count').textContent = state.sharedKey ? active.length : active.filter(account => account.hasKey).length;
  const openDetails = new Set([...document.querySelectorAll('.account-card')].filter(node => node.querySelector('.setup-details')?.open).map(node => node.dataset.accountId));
  $('#account-list').replaceChildren(...visible.map(card));
  for (const node of document.querySelectorAll('.account-card')) if (openDetails.has(node.dataset.accountId)) node.querySelector('.setup-details').open = true;
  $('#empty-state').hidden = visible.length > 0;
  $('#data-path').textContent = `本地保存位置：${state.dataDir}`;
}

async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  try { state = await api('/state'); render(); notice(''); }
  catch (error) { notice(error.message); }
  finally { refreshPending = false; }
}

function editSharedKey() {
  $('#master-key-form').reset();
  $('#master-key-error').hidden = true;
  $('#master-key-status').textContent = state.sharedKey ? `当前已保存 Key（尾号 ${state.sharedKeyHint || '****'}）。填写新 Key 会覆盖。` : '尚未保存共享 Key。';
  $('#master-key-dialog').showModal();
  $('#master-key-input').focus();
}

function editAccount(account = null) {
  $('#account-form').reset();
  $('#account-id').value = account?.id || '';
  $('#account-label').value = account?.label || '';
  $('#account-email').value = account?.email || '';
  $('#dialog-title').textContent = account ? '编辑账号' : '新建独立环境';
  $('#form-error').hidden = true;
  $('#account-browser').replaceChildren(...state.browsers.map(browser => {
    const option = el('option', '', browser.name);
    option.value = browser.id;
    return option;
  }));
  if (account) $('#account-browser').value = account.browserId;
  $('#browser-field').hidden = Boolean(account);
  $('#create-login-field').hidden = Boolean(account);
  $('#create-login').checked = !account;
  $('#save-button').textContent = account ? '保存账号' : '创建环境';
  $('#account-key').placeholder = account?.hasKey ? '留空保留原有 Key；填写后更新' : 'cat-…';
  $('#key-help').textContent = '留空沿用已有 Key 或共享 Key。后台启动时从本机保险箱载入，运行中修改后需重启内核生效。';
  $('#account-dialog').showModal();
  $('#account-label').focus();
}

async function archiveAccount(account, archived) {
  const result = await api(`/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ archived }) });
  state.accounts = result.accounts;
  render();
  toast(archived ? '账号已归档，浏览器资料与 Key 已保留。' : '账号已恢复。');
}

$('#account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('#account-id').value;
  const input = { label: $('#account-label').value, email: $('#account-email').value, key: $('#account-key').value };
  if (!id) input.browserId = $('#account-browser').value;
  $('#form-error').hidden = true;
  try {
    await busy($('#save-button'), async () => {
      const result = await api(id ? `/accounts/${id}` : '/accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(input) });
      state.accounts = result.accounts;
      $('#account-dialog').close();
      render();
      toast(input.key ? '账号与 Key 已在本机加密保存。' : '独立环境已保存。');
      if (!id && $('#create-login').checked && result.account) await runtimeAction(result.account, 'login');
    }, input.key ? '正在加密保存…' : '保存中…');
  } catch (error) {
    if ($('#account-dialog').open) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
    else toast(error.message);
  }
  finally { input.key = ''; $('#account-key').value = ''; }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
$('#account-dialog').addEventListener('close', () => { $('#account-key').value = ''; });
$('#master-key-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#master-key-error').hidden = true;
  try {
    await busy($('#master-key-save'), async () => {
      const result = await api('/key', { method: 'POST', body: JSON.stringify({ key: $('#master-key-input').value }) });
      state.sharedKey = result.sharedKey;
      state.sharedKeyHint = result.sharedKeyHint;
      $('#master-key-dialog').close();
      render();
      toast('共享 Key 已使用当前 Windows 用户加密保存。');
    }, '正在加密保存…');
  } catch (error) { $('#master-key-error').textContent = error.message; $('#master-key-error').hidden = false; }
  finally { $('#master-key-input').value = ''; }
});
$('#manage-key').addEventListener('click', editSharedKey);
$('#add-button').addEventListener('click', () => editAccount());
$('#empty-add').addEventListener('click', () => editAccount());
$('#show-archived').addEventListener('change', render);
$('#refresh-button').addEventListener('click', refresh);

async function runtimeAction(account, command) {
  const result = await api(`/accounts/${account.id}/runtime/${command}`, { method: 'POST' });
  state.accounts = result.accounts; render();
  toast(['start', 'restart', 'finish-login'].includes(command) ? '已提交后台启动，正在检查登录态，请观察状态和日志。' : command === 'login' ? '已打开普通登录窗口。手动进入 AI Studio 后，先关闭该账号的全部登录窗口，再点击“完成登录并转后台”。' : '操作已完成。');
}

async function batch(action) {
  const result = await api('/runtime/batch', { method: 'POST', body: JSON.stringify({ action }) });
  state.accounts = result.accounts; render();
  const errors = result.results.filter(item => !item.ok);
  toast(errors.length ? `${errors.length} 个账号未完成，请查看各账号状态。` : '批量操作已提交，请观察各账号运行状态。');
}

async function updateDetails() {
  if (!detailAccount || !$('#runtime-dialog').open) return;
  try {
    const data = await api(`/accounts/${detailAccount.id}/runtime/logs`);
    $('#runtime-detail-status').textContent = `${PHASES[data.runtime.phase] || data.runtime.phase} · 心跳发送 ${data.runtime.pingCount || 0} 次 / 回应 ${data.runtime.pongCount || 0} 次 · 进程 ${data.runtime.pid || '未启动'}`;
    const pre = $('#runtime-logs'); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = data.logs.length ? data.logs.map(row => `[${when(row.at)}] ${row.message}`).join('\n') : '暂无日志。启动账号后，运行日志会显示在这里。';
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  } catch (error) { $('#runtime-error').textContent = error.message; $('#runtime-error').hidden = false; }
}

async function showDetails(account) {
  detailAccount = account; $('#runtime-title').textContent = `${account.label} · 运行详情`;
  $('#runtime-preview').hidden = true; $('#runtime-error').hidden = true;
  const manual = account.runtime?.mode === 'login';
  $('#preview-page').disabled = manual; $('#reload-page').disabled = manual;
  if (manual) {
    $('#runtime-error').textContent = '普通登录窗口未连接调试器，因此不提供页面预览或自动重载。请在该窗口手动登录，关闭后再转后台。';
    $('#runtime-error').hidden = false;
  }
  $('#runtime-dialog').showModal(); await updateDetails();
}

function editSettings(account) {
  const cfg = account.runtime?.settings || { pushMinutes: 45, autoPush: false, autoHi: true, autoRestart: true };
  $('#settings-account').value = account.id; $('#settings-interval').value = cfg.pushMinutes;
  $('#settings-hi').checked = cfg.autoHi; $('#settings-push').checked = cfg.autoPush; $('#settings-restart').checked = cfg.autoRestart;
  $('#settings-dialog').showModal();
}

function updateNetworkFields() {
  const custom = $('#network-mode').value === 'custom';
  $('#network-server-field').hidden = !custom;
  $('#network-server').required = custom;
  $('#network-server').disabled = !custom;
}
$('#manage-network').addEventListener('click', () => {
  $('#network-mode').value = state.network?.mode || 'system';
  $('#network-server').value = state.network?.server || '';
  $('#network-error').hidden = true;
  updateNetworkFields();
  $('#network-dialog').showModal();
});
$('#network-mode').addEventListener('change', updateNetworkFields);
$('#network-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#network-error').hidden = true;
  try {
    await busy($('#network-save'), async () => {
      const result = await api('/network', { method: 'PATCH', body: JSON.stringify({ mode: $('#network-mode').value, server: $('#network-server').value }) });
      state.network = result.network;
      $('#network-dialog').close();
      toast('网络设置已保存，请重启运行中的账号使其生效。');
    });
  } catch (error) { $('#network-error').textContent = error.message; $('#network-error').hidden = false; }
});

$('#start-all').addEventListener('click', event => busy(event.target, () => batch('start')).catch(error => toast(error.message)));
$('#stop-all').addEventListener('click', event => busy(event.target, () => batch('stop')).catch(error => toast(error.message)));
$('#refresh-logs').addEventListener('click', updateDetails);
$('#clear-logs').addEventListener('click', async () => { if (detailAccount) { await runtimeAction(detailAccount, 'clear-logs').catch(error => toast(error.message)); await updateDetails(); } });
$('#reload-page').addEventListener('click', async () => { if (detailAccount) await runtimeAction(detailAccount, 'reload').catch(error => toast(error.message)); });
$('#preview-page').addEventListener('click', async event => {
  if (!detailAccount) return;
  await busy(event.target, async () => {
    const response = await fetch(`/api/accounts/${detailAccount.id}/runtime/preview`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error((await response.json()).error);
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await response.blob());
    $('#runtime-preview').src = previewUrl; $('#runtime-preview').hidden = false;
  }).catch(error => toast(error.message));
});
$('#runtime-dialog').addEventListener('close', () => { detailAccount = null; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; $('#runtime-preview').removeAttribute('src'); });
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await api(`/accounts/${$('#settings-account').value}/runtime/settings`, { method: 'PATCH', body: JSON.stringify({ pushMinutes: Number($('#settings-interval').value), autoHi: $('#settings-hi').checked, autoPush: $('#settings-push').checked, autoRestart: $('#settings-restart').checked }) });
    state.accounts = result.accounts; render(); $('#settings-dialog').close(); toast('设置已保存，下次启动或重启生效。');
  } catch (error) { toast(error.message); }
});
setInterval(() => { if (!document.hidden) { refresh(); updateDetails(); } }, 5000);
refresh();
