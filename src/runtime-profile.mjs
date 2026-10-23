import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { accountId, atomicWrite, AppError } from './store.mjs';

export const runtimeProfile = (dataDir, id) => path.join(dataDir, 'runtime-profiles', accountId(id));

// Every environment starts empty. Existing Chrome profiles are never discovered or copied.
export async function prepareRuntimeProfile(dataDir, account) {
  if (account.source?.type === 'chrome-existing') throw new AppError('旧 Chrome 导入已移除，请新建独立环境并手动登录。', 409);
  const destination = runtimeProfile(dataDir, account.id);
  await mkdir(path.join(destination, 'Default'), { recursive: true });
  const marker = path.join(destination, 'environment.json');
  if (!await access(marker).then(() => true, () => false)) {
    await atomicWrite(marker, JSON.stringify({ version: 1, accountId: account.id, createdAt: new Date().toISOString(), source: 'manual-login' }));
  }
  return destination;
}
