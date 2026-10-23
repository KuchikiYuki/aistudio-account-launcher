import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

test('console mode reports service and account status without exposing keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-console-test-'));
  const output = [];
  const runtime = {
    async init() {},
    async close() {},
    snapshot() { return { phase: 'online', running: true, pingCount: 3, pongCount: 2 }; },
    job() { return { logs: [] }; },
  };
  let app;
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = value => { output.push(String(value)); return true; };
    app = await startServer({ dataDir: root, browsers: [{ id: 'chrome', name: 'Chrome', executable: 'unused' }], runtime, console: true, port: 0 });
    assert.ok(output.some(line => line.includes('[服务] 已监听')));
    assert.ok(output.some(line => line.includes('[状态]')));
    assert.equal(output.some(line => line.includes('cat-')), false);
  } finally {
    process.stdout.write = originalWrite;
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
