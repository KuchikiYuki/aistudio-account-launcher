import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, AccountStore, KeyVault, accountId } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

let root;
let store;
let app;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-account-launcher-'));
  store = new AccountStore(root, ['chrome', 'edge']);
  await store.init();
});

after(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

test('creates accounts without placing API keys in the account index', async () => {
  const created = await store.create({ label: '工作账号', email: 'person@example.com', browserId: 'chrome', key: 'cat-secret-test-key-9287' });
  const index = await readFile(path.join(root, 'accounts.json'), 'utf8');
  assert.equal(created.keyHint, '9287');
  assert.equal(index.includes('cat-secret-test-key-9287'), false);
  assert.equal(index.includes('9287'), true);
  assert.deepEqual((await store.list()).map(item => item.hasKey), [true]);
  assert.equal(await store.vault.reveal(created.id), 'cat-secret-test-key-9287');
});

test('protects the backup with Windows user encryption and rejects invalid keys', async () => {
  const vault = new KeyVault(root);
  const id = 'ad7ec551-849f-42e3-bdbc-63130d00e272';
  await assert.rejects(vault.save(id, 'wrong-value'), AppError);
  await vault.save(id, 'cat-encrypted-roundtrip-test-5432');
  const encrypted = await readFile(vault.file(id), 'utf8');
  assert.equal(encrypted.includes('cat-encrypted-roundtrip-test-5432'), false);
  assert.equal(await vault.reveal(id), 'cat-encrypted-roundtrip-test-5432');
  await vault.saveShared('cat-shared-test-key-7731');
  const sharedFile = await readFile(vault.sharedFile, 'utf8');
  assert.equal(sharedFile.includes('cat-shared-test-key-7731'), false);
  assert.equal(await vault.revealShared(), 'cat-shared-test-key-7731');
  assert.throws(() => accountId('../accounts.json'), AppError);
});

test('creates only independent account records, ignoring legacy source input', async () => {
  const created = await store.create({ label: '独立账号', email: 'manual@example.com', browserId: 'chrome', source: { type: 'chrome-existing', directory: 'Default' } });
  assert.equal(created.source, undefined);
  assert.equal(typeof store.importProfile, 'undefined');
  assert.equal(created.email, 'manual@example.com');
});

test('retires legacy imported records once while preserving a recoverable backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aistudio-retire-test-'));
  try {
    const legacy = { id: 'c596245f-0fee-461f-8b9b-2bf72a8a88d4', label: 'Old', browserId: 'chrome', source: { type: 'chrome-existing', directory: 'Default' } };
    await writeFile(path.join(directory, 'accounts.json'), JSON.stringify({version:1,accounts:[legacy]}));
    const retired = new AccountStore(directory, ['chrome']); await retired.init();
    assert.equal(retired.data.accounts.length, 0);
    const backups = await readdir(path.join(directory, 'backups'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'backups', backups[0]), 'utf8')).accounts, [legacy]);
    await retired.init();
    assert.equal((await readdir(path.join(directory, 'backups'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('protects independent runtime APIs and rejects removed Chrome import endpoints', async () => {
  app = await startServer({ dataDir: root, browsers: [{ id: 'chrome', name: 'Google Chrome', executable: 'unused' }], port: 0 });
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  assert.equal((await fetch(app.origin + '/api/state', {headers:{...headers,Origin:'https://evil.example'}})).status, 403);
  const state = await fetch(app.origin + '/api/state', {headers}).then(response => response.json());
  assert.equal(state.accounts.length, 2);
  assert.equal(JSON.stringify(state).includes('cat-secret-test-key-9287'), false);
  assert.equal(JSON.stringify(state).includes('cat-encrypted-roundtrip-test-5432'), false);
  for (const route of ['/api/chrome-profiles', '/catiecli.user.js']) assert.equal((await fetch(app.origin + route, {headers})).status, 404);
  assert.equal((await fetch(app.origin + '/api/import-chrome', {method:'POST',headers,body:'{"ids":[]}'})).status, 404);
  assert.equal((await fetch(app.origin + '/api/key-bootstrap', {method:'POST',headers,body:'{}'})).status, 404);
  const createdResponse = await fetch(app.origin + '/api/accounts', {method:'POST',headers,body:JSON.stringify({label:'New manual environment',browserId:'chrome'})});
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.account.source, undefined);
  assert.equal(created.account.label, 'New manual environment');
  assert.equal(created.accounts.length, 3);
  const runtime = app.origin + '/api/accounts/' + created.account.id + '/runtime/';
  assert.equal((await fetch(runtime + 'reimport', {method:'POST',headers,body:'{}'})).status, 404);
  assert.equal((await fetch(runtime + 'settings', {method:'PATCH',headers,body:JSON.stringify({pushMinutes:30,autoHi:true,autoPush:false})})).status, 200);
  assert.equal((await fetch(runtime + 'logs', {headers})).status, 200);
  assert.equal((await fetch(runtime + 'finish-login', {method:'POST',headers,body:'{}'})).status, 409);
  assert.equal((await fetch(app.origin + '/api/key', {method:'POST',headers,body:JSON.stringify({key:'cat-global-test-key-6619'})})).status, 200);
  const refreshed = await fetch(app.origin + '/api/state', {headers}).then(response => response.json());
  assert.equal(refreshed.sharedKey, true);
  assert.equal(JSON.stringify(refreshed).includes('cat-global-test-key-6619'), false);
  assert.equal(refreshed.accounts.length, 3);
});
