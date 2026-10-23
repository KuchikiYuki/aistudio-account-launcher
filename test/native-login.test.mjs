import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nativeLoginArgs, NativeLogin } from '../src/native-login.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';

test('normal login arguments contain only the independent profile and navigation settings', () => {
  const profile = path.resolve('test profile');
  const args = nativeLoginArgs(profile);
  assert.ok(args.includes('--user-data-dir=' + profile));
  assert.ok(args.includes('--new-window'));
  assert.equal(args.some(value => /remote-debugging|automation|headless|disable-blink|webdriver|disable-web-security|ignore-certificate/i.test(value)), false);
  assert.equal(args.some(value => value.includes('cat-')), false);
});

test('normal login refuses premature handoff and never automates the login form', async () => {
  const child = new EventEmitter(); child.pid = 42;
  let options;
  const login = new NativeLogin({ executable: 'chrome', profile: path.resolve('own-profile'), spawnBrowser: (_exe, _args, opts) => { options = opts; queueMicrotask(() => child.emit('spawn')); return child; } });
  await login.start();
  assert.equal(options.windowsHide, false);
  assert.throws(() => login.checkClosed(), /正常关闭/);
  child.emit('exit', 0);
  assert.deepEqual(login.checkClosed(), {closed:true,email:null,loginVerified:false});
});

test('manager launches manual login without a worker or key and retains handoff after window close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-normal-login-'));
  const id = 'c596245f-0fee-461f-8b9b-2bf72a8a88d4';
  const account = {id,label:'Manual',browserId:'chrome'};
  let keyRead = false; let workerSpawned = false;
  const login = new EventEmitter(); login.closed = false; login.child = {pid:99};
  login.start = async () => ({pid:99});
  login.checkClosed = () => { if (!login.closed) throw new Error('尚未关闭'); return {closed:true,email:null,loginVerified:false}; };
  login.close = async () => { login.closed = true; login.emit('closed'); };
  const manager = new RuntimeManager({store:{dataDir:root,find:()=>account,vault:{reveal:async()=>{keyRead=true;}}},browsers:[{id:'chrome',executable:'mock'}],projectRoot:root,prepare:async()=>root,spawn:()=>{workerSpawned=true;throw new Error('no worker during login');},nativeLogin:()=>login});
  try {
    await manager.init(); await manager.launch(id,{loginMode:true}); await manager.job(id).launchPromise;
    assert.equal(manager.snapshot(id).phase,'login_window');
    assert.equal(keyRead,false); assert.equal(workerSpawned,false);
    assert.throws(()=>manager.command(id,'check-login'), /尚未关闭/);
    login.closed = true; login.emit('closed');
    assert.equal(manager.snapshot(id).phase,'login_closed');
    assert.equal(manager.snapshot(id).pendingLogin,true);
    assert.equal(manager.snapshot(id).running,false);
    assert.equal((await manager.command(id,'check-login')).loginVerified,false);
    await manager.stop(id); assert.equal(manager.snapshot(id).pendingLogin,false);
  } finally { await manager.close(); await rm(root,{recursive:true,force:true}); }
});
