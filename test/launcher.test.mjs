import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../启动.cmd', import.meta.url));

test('Windows launcher contains ASCII commands and CRLF line endings', async () => {
  const bytes = await readFile(launcher);
  assert.ok(bytes.every(byte => byte < 128), 'Keep CMD source ASCII; user-facing runtime messages belong in Node.');
  const text = bytes.toString('ascii');
  assert.ok(text.includes('\r\n'));
  assert.equal(/(?<!\r)\n/.test(text), false, 'Bare LF can break Windows batch parsing.');
});

test('cmd.exe runs launcher in Unicode paths and preserves exit diagnostics', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-cmd-中文 space-'));
  const run = async (...args) => execute(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `call "启动.cmd" ${args.join(' ')} < nul`], { cwd: root, encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: true });
  try {
    await copyFile(launcher, path.join(root, '启动.cmd'));
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'node_modules', 'playwright-core'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'playwright-core', 'package.json'), '{}');
    await writeFile(path.join(root, 'src', 'server.mjs'), "console.log('FIXTURE_READY'); console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv.includes('--fail') ? 7 : 0);");

    const success = await run('--no-open', '--port=0');
    assert.ok(success.stdout.includes('FIXTURE_READY'));
    assert.ok(success.stdout.includes('["--console","--no-open","--port=0"]'));
    assert.ok(success.stdout.includes('[STOP] This launcher invocation has finished.'));
    assert.ok(success.stdout.includes('Press any key to close this window...'));
    assert.equal(success.stderr.trim(), '');

    const direct = await execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(root, '启动.cmd')}" --no-open --port=0 < nul"`], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: true });
    assert.ok(direct.stdout.includes('FIXTURE_READY'));
    assert.ok(direct.stdout.includes('["--console","--no-open","--port=0"]'));
    assert.equal(direct.stderr.trim(), '');

    await assert.rejects(run('--fail'), error => {
      assert.equal(error.code, 7);
      assert.ok(error.stdout.includes('[ERROR] Service exited with code 7.'));
      assert.ok(error.stdout.includes('Press any key to close this window...'));
      assert.equal(error.stderr.trim(), '');
      return true;
    });

    const paused = execute(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call "启动.cmd" --fail'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: true });
    const outcome = paused.then(value => ({ value }), error => ({ error }));
    try {
      let output = '';
      paused.child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
      for (let attempt = 0; attempt < 100 && !output.includes('Press any key to close'); attempt++) await delay(25);
      assert.ok(output.includes('[ERROR] Service exited with code 7.'));
      assert.ok(output.includes('Press any key to close'));
      await delay(150);
      assert.equal(paused.child.exitCode, null, 'The error window must wait for user input.');
      paused.child.stdin.end('\r\n');
      const result = await outcome;
      assert.equal(result.error?.code, 7);
    } finally {
      if (paused.child.exitCode === null) paused.child.kill();
      await outcome;
    }

    await rm(path.join(root, 'node_modules'), { recursive: true });
    await assert.rejects(run(), error => {
      assert.equal(error.code, 1);
      assert.ok(error.stdout.includes('[ERROR] Missing playwright-core.'));
      assert.ok(error.stdout.includes('Press any key to close this window...'));
      assert.equal(error.stdout.includes('FIXTURE_READY'), false);
      assert.equal(error.stderr.trim(), '');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
