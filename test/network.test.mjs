import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { detectBrowsers } from '../src/browser.mjs';
import { startServer } from '../src/server.mjs';
import { validateNetwork, NetworkSettings, proxyOptions, networkBrowserArgs, backendRequest } from '../src/network.mjs';
import { nativeLoginArgs } from '../src/native-login.mjs';
import { StudioNavigation, STUDIO_URL } from '../src/studio-navigation.mjs';

test('network preferences reject credential-bearing URLs and survive service restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-network-'));
  try {
    for (const server of ['http://user:secret@localhost:10090', 'file:///tmp', 'http://localhost/path', 'http://localhost/?secret=key', 'http://localhost/#key', 'bad-url']) {
      assert.throws(() => validateNetwork({ mode: 'custom', server }));
    }
    assert.throws(() => validateNetwork({ mode: 'other' }));
    assert.deepEqual(proxyOptions({ mode: 'custom', server: 'socks5://localhost:10090/' }), { proxy: { server: 'socks5://localhost:10090' } });
    assert.deepEqual(networkBrowserArgs({ mode: 'direct' }), ['--no-proxy-server']);
    const network = new NetworkSettings(root);
    await network.init();
    assert.equal(network.snapshot().mode, 'system');
    await network.save({ mode: 'custom', server: 'http://127.0.0.1:10090/' });
    const restored = new NetworkSettings(root);
    await restored.init();
    assert.deepEqual(restored.snapshot(), { mode: 'custom', server: 'http://127.0.0.1:10090' });
    assert.ok(nativeLoginArgs(root, undefined, restored.snapshot()).includes('--proxy-server=http://127.0.0.1:10090'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('network API requires authorization and retains only validated settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-network-api-'));
  let app;
  try {
    app = await startServer({ dataDir: root, browsers: [] });
    const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
    const input = { mode: 'custom', server: 'http://127.0.0.1:10090' };
    const endpoint = app.origin + '/api/network';
    assert.equal((await fetch(endpoint, { method: 'PATCH', body: JSON.stringify(input) })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify({ ...input, server: 'http://user:secret@localhost' }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(input) })).status, 200);
    const state = await fetch(app.origin + '/api/state', { headers }).then(response => response.json());
    assert.deepEqual(state.network, input);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('navigation retries the original URL with backoff and recovers without overlapping loads', async () => {
  let now = 1000; let calls = 0; let failures = 2;
  const states = []; const logs = []; const urls = [];
  const page = { async goto(url) { calls++; urls.push(url); if (failures-- > 0) throw new Error('net::ERR_CONNECTION_TIMED_OUT'); return { status: () => 200 }; } };
  const navigation = new StudioNavigation({ page, now: () => now, report: value => states.push(value), log: line => logs.push(line) });
  const first = navigation.navigate();
  assert.equal(first, navigation.navigate());
  assert.equal(await first, false);
  assert.equal(calls, 1);
  assert.equal(navigation.retryAt, 16000);
  assert.equal(await navigation.tick(), true);
  assert.equal(calls, 1);
  now = 16000; await navigation.tick();
  assert.equal(navigation.retryAt, 46000);
  now = 46000; await navigation.tick();
  assert.equal(navigation.retryAt, 0);
  assert.equal(await navigation.tick(), false);
  await navigation.navigate(); // Manual reload always goes to the real AI Studio URL.
  assert.deepEqual(urls, Array(4).fill(STUDIO_URL));
  assert.ok(states.some(value => value.phase === 'network_error' && value.waaReady === false && value.wsStatus === 'disconnected'));
  assert.ok(logs.some(value => value.includes('网页已载入')));
  failures = 10;
  for (const seconds of [15, 30, 60, 120, 120]) {
    await navigation.navigate();
    assert.equal(navigation.retryAt - now, seconds * 1000);
    now = navigation.retryAt;
  }
  navigation.stop();
  const before = calls;
  await navigation.tick(); await navigation.navigate();
  assert.equal(calls, before);
});

test('a configured proxy carries real browser navigation, WebSocket and backend POST with no direct DNS fallback', { timeout: 30000 }, async t => {
  const browser = (await detectBrowsers()).find(item => item.id === 'chrome');
  if (!browser) return t.skip('Chrome is not installed');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aistudio-proxy-test-'));
  const requests = []; const tunnels = []; const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, key: req.headers['x-api-key'] });
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://other.invalid/leak' }); res.end(); return; }
    if (req.url === '/push') { res.end('push-ok'); return; }
    if (req.url === '/update') { res.end('update-ok'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body>proxy fixture<script>window.socket=new WebSocket("ws://studio.invalid/socket"); window.socket.onopen=()=>window.socketOpened=true;</script></body></html>');
  });
  upstream.on('connection', track);
  upstream.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  const proxy = http.createServer((req, res) => {
    const target = new URL(req.url);
    const outgoing = http.request({ hostname: '127.0.0.1', port: upstream.address().port, path: target.pathname, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    outgoing.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(outgoing);
  });
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    const tunnel = net.connect(upstream.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      client.pipe(tunnel); tunnel.pipe(client);
    });
    track(tunnel);
    client.on('close', () => tunnel.destroy());
  });
  let context;
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const network = { mode: 'custom', server: `http://127.0.0.1:${proxy.address().port}` };
    context = await chromium.launchPersistentContext(root, { executablePath: browser.executable, channel: 'chromium', headless: true, ...proxyOptions(network) });
    const page = context.pages()[0];
    await page.goto('http://studio.invalid/prompts/new_chat', { timeout: 10000 });
    await page.waitForFunction(() => window.socketOpened, { timeout: 10000 });
    const update = await backendRequest(context.request, 'http://backend.invalid/update');
    assert.equal(update.responseText, 'update-ok');
    const push = await backendRequest(context.request, 'http://backend.invalid/push', { method: 'POST', headers: { 'X-API-Key': 'fixture-key' }, data: '{"fixture":true}' });
    assert.equal(push.status, 200); assert.equal(push.responseText, 'push-ok');
    assert.ok(requests.some(item => item.method === 'POST' && item.url === '/push' && item.key === 'fixture-key'));
    assert.ok(tunnels.includes('studio.invalid:80'));
    await assert.rejects(backendRequest(context.request, 'http://backend.invalid/redirect', { headers: { 'X-API-Key': 'fixture-key' } }), /重定向/);
    assert.equal(requests.some(item => item.url === '/leak'), false);
  } finally {
    await context?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([upstream, proxy].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    await rm(root, { recursive: true, force: true });
  }
});
