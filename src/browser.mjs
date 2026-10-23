import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export async function detectBrowsers() {
  const candidates = [
    ['chrome', 'Google Chrome', path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')],
    ['chrome', 'Google Chrome', path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe')],
    ['chrome', 'Google Chrome', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')],
    ['edge', 'Microsoft Edge', path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')],
    ['edge', 'Microsoft Edge', path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')],
  ];
  const browsers = [];
  for (const [id, name, executable] of candidates) {
    if (!browsers.some(browser => browser.id === id) && await access(executable).then(() => true, () => false)) browsers.push({ id, name, executable });
  }
  return browsers;
}

export function openLocalPage(url) {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
