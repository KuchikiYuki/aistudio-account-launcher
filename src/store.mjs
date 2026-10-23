import { mkdir, readFile, rename, writeFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function accountId(value) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new AppError('账号编号无效。');
  }
  return value;
}

export async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

const vaultScript = fileURLToPath(new URL('../scripts/vault.ps1', import.meta.url));

function crypt(operation, value) {
  if (process.platform !== 'win32') throw new AppError('当前版本使用 Windows 本机加密，请在 Windows 上运行。', 503);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', vaultScript, '-Operation', operation], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new AppError('本机加密操作超时，请重试。', 503));
    }, 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    // Never forward encryption input, decrypted output, or process diagnostics to a log.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new AppError('无法启动 Windows 本机加密服务。', 503)));
    child.on('close', code => finish(code === 0 ? null : new AppError('无法读取或保存 Key。请使用创建这些数据的 Windows 用户登录后重试。', 503), output));
    child.stdin.end(JSON.stringify({ value }));
  });
}

export class KeyVault {
  constructor(dataDir) { this.directory = path.join(dataDir, 'keys'); }
  file(id) { return path.join(this.directory, `${accountId(id)}.dpapi`); }
  get sharedFile() { return path.join(this.directory, 'shared.dpapi'); }
  async save(id, rawKey) {
    if (typeof rawKey !== 'string') throw new AppError('请填写 Key。');
    const key = rawKey.trim();
    if (!key.startsWith('cat-') || key.length < 8 || key.length > 512 || /\s/.test(key)) {
      throw new AppError('请填写完整的 cat- 开头 Key，中间不要包含空格。');
    }
    const encrypted = await crypt('Protect', key);
    await atomicWrite(this.file(id), encrypted);
    return key.slice(-4);
  }
  async exists(id) { return access(this.file(id)).then(() => true, () => false); }
  async saveShared(rawKey) {
    if (typeof rawKey !== 'string') throw new AppError('请填写 Key。');
    const key = rawKey.trim();
    if (!key.startsWith('cat-') || key.length < 8 || key.length > 512 || /\s/.test(key)) throw new AppError('请填写完整的 cat- 开头 Key，中间不要包含空格。');
    await atomicWrite(this.sharedFile, await crypt('Protect', key));
    return key.slice(-4);
  }
  async hasShared() { return access(this.sharedFile).then(() => true, () => false); }
  async revealShared() { return crypt('Unprotect', await readFile(this.sharedFile, 'utf8')); }
  async reveal(id) {
    // Internal capability for the next phase; no HTTP endpoint exposes this method.
    return crypt('Unprotect', await readFile(this.file(id), 'utf8'));
  }
}

function textField(value, maximum, label) {
  if (typeof value !== 'string' || value.trim().length > maximum || /[\x00-\x1f]/.test(value)) {
    throw new AppError(`${label}格式不正确。`);
  }
  return value.trim();
}

export class AccountStore {
  constructor(dataDir, browserIds) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'accounts.json');
    this.browserIds = browserIds;
    this.vault = new KeyVault(dataDir);
    this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('账号清单无法读取，已保留原文件，请先检查数据目录。');
      this.data = { version: 1, accounts: [] };
      await this.persist();
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.accounts)) throw new Error('账号清单格式不受支持，原数据未被修改。');
    for (const account of this.data.accounts) accountId(account.id);
    // Retire imported records once, preserving a recoverable local backup and all keys.
    const legacy = this.data.accounts.filter(account => account.source?.type === 'chrome-existing');
    if (legacy.length) {
      const backup = path.join(this.dataDir, 'backups', `retired-chrome-imports-${Date.now()}.json`);
      await atomicWrite(backup, JSON.stringify({ version: 1, retiredAt: new Date().toISOString(), accounts: legacy }, null, 2));
      const next = { ...this.data, accounts: this.data.accounts.filter(account => account.source?.type !== 'chrome-existing') };
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.data = next;
    }
  }
  persist() { return atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }
  mutate(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  find(id) {
    const account = this.data.accounts.find(item => item.id === accountId(id));
    if (!account) throw new AppError('找不到这个账号。', 404);
    return account;
  }
  validate(input, previous = {}) {
    const label = textField(input.label ?? previous.label ?? '', 60, '账号名称');
    const email = textField(input.email ?? previous.email ?? '', 254, '邮箱');
    if (!label) throw new AppError('请填写账号名称。');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('邮箱格式不正确，也可以先留空。');
    const browserId = input.browserId ?? previous.browserId ?? this.browserIds[0];
    if (!this.browserIds.includes(browserId)) throw new AppError('所选浏览器不可用。请先安装 Chrome 或 Edge。');
    if (previous.createdAt && browserId !== previous.browserId) throw new AppError('此环境需要继续使用原内核，请另建环境来更换内核。');
    return { label, email, browserId };
  }
  create(input) {
    return this.mutate(async () => {
      const account = { id: randomUUID(), ...this.validate(input), createdAt: new Date().toISOString(), archived: false };
      if (input.key) account.keyHint = await this.vault.save(account.id, input.key);
      const next = { ...this.data, accounts: [...this.data.accounts, account] };
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.data = next;
      return { ...account };
    });
  }
  update(id, input) {
    return this.mutate(async () => {
      const previous = this.find(id);
      const account = { ...previous, ...this.validate(input, previous), updatedAt: new Date().toISOString() };
      if (input.key) account.keyHint = await this.vault.save(id, input.key);
      if (input.archived !== undefined) {
        if (typeof input.archived !== 'boolean') throw new AppError('归档状态无效。');
        account.archived = input.archived;
      }
      if (input.touchOpened) account.lastOpenedAt = new Date().toISOString();
      const next = { ...this.data, accounts: this.data.accounts.map(item => item.id === id ? account : item) };
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.data = next;
      return { ...account };
    });
  }
  async list() {
    const sharedKey = await this.vault.hasShared();
    const sharedHint = sharedKey ? (await this.vault.revealShared()).slice(-4) : null;
    return Promise.all(this.data.accounts.map(async account => {
      const own = await this.vault.exists(account.id);
      return { ...account, hasKey: own || sharedKey, keyHint: own ? account.keyHint : sharedHint };
    }));
  }
}
