import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { detectBrowsers } from '../src/browser.mjs';
import { browserHost } from '../src/userscript-host.mjs';

const script = await readFile(new URL('../vendor/catiecli-playground.user.js', import.meta.url), 'utf8');

function fixture(buttons) {
  return `<!doctype html><html lang="hi"><body>
    <button id="outside" aria-label="Run">Run</button>
    <ms-prompt-box><textarea></textarea>
      <button id="media"><mat-icon>add_circle</mat-icon></button>
      ${buttons}
    </ms-prompt-box><script>
    window.clicks = [];
    window.default_MakerSuite = { snapshot: function(service, digest) { /* .snapshot({ content yield */ return Promise.resolve('!fixture-proof'); } };
    class FixtureSocket {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
      send(raw) { if (JSON.parse(raw).type === 'register') setTimeout(() => this.onmessage?.({data:JSON.stringify({type:'registered'})}), 1); }
      close() { this.readyState = 3; }
    }
    window.WebSocket = FixtureSocket;
    for (const element of document.querySelectorAll('button,[role=button]')) element.onclick = () => {
      window.clicks.push(element.id);
      if (element.id === 'send') window.default_MakerSuite.snapshot({content:'fixture'}, 'digest');
    };
    </script></body></html>`;
}

test('activation handles localized run controls and refuses stop, disabled and ambiguous controls', { timeout: 30000 }, async t => {
  const browser = (await detectBrowsers()).find(item => item.id === 'chrome');
  if (!browser) return t.skip('Chrome is not installed');
  const instance = await chromium.launch({ executablePath: browser.executable, channel: 'chromium', headless: true });
  const cases = [
    ['Hindi run component', '<ms-run-button><button id="send">दौड़ना <mat-icon>keyboard_return</mat-icon></button></ms-run-button>', true],
    ['localized icon without component', '<button id="send" aria-label="चलाएँ"><mat-icon>keyboard_return</mat-icon></button>', true],
    ['translated label without icon', '<ms-run-button><button id="send">実行</button></ms-run-button>', true],
    ['localized stop icon', '<ms-run-button><button id="stop">रोकें <mat-icon>stop</mat-icon></button></ms-run-button>', false],
    ['aria disabled run', '<ms-run-button><div role="button" aria-disabled="true" id="send"><mat-icon>keyboard_return</mat-icon></div></ms-run-button>', false],
    ['native disabled run', '<ms-run-button><button disabled id="send"><mat-icon>keyboard_return</mat-icon></button></ms-run-button>', false],
    ['equally plausible run controls', '<ms-run-button><button id="send"><mat-icon>keyboard_return</mat-icon></button><button id="other"><mat-icon>keyboard_return</mat-icon></button></ms-run-button>', false],
    ['outside prompt and media only', '', false],
  ];
  try {
    for (const [name, buttons, sends] of cases) await t.test(name, async () => {
      const context = await instance.newContext();
      try {
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture(buttons) }));
        await context.exposeBinding('__runnerBridge', async () => true);
        await context.addInitScript({ content: browserHost({ key: 'cat-fake-localized-test', storage: { pg_auto_cookie_push: false } }, script) });
        const page = await context.newPage();
        await page.goto('https://aistudio.google.com/prompts/new_chat');
        await page.waitForFunction(() => document.querySelector('textarea').value === 'hi');
        if (sends) {
          await page.waitForFunction(() => window.__aistudioRunner.status().wsStatus === 'connected');
          assert.deepEqual(await page.evaluate(() => window.clicks), ['send']);
          assert.equal(await page.evaluate(() => window.__aistudioRunner.status().waaReady), true);
        } else {
          await page.clock.install();
          await page.clock.fastForward(125000);
          assert.deepEqual(await page.evaluate(() => window.clicks), []);
          assert.equal(await page.evaluate(() => window.__aistudioRunner.status().waaReady), false);
        }
      } finally { await context.close(); }
    });
  } finally { await instance.close(); }
});
