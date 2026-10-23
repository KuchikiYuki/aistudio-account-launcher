import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowedDirectories = new Set(['src', 'public', 'scripts', 'test', 'vendor']);
const allowedFiles = new Set(['.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'README.md', 'SECURITY.md', 'PUBLISHING.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE_CHECK.md', '启动.cmd']);
const sensitiveNames = /^(?:\.data|\.env(?:\..*)?|runtime-profiles|profiles|backups|screenshots|logs|Cookies(?:-journal)?|Login Data(?:-journal)?|Local State|Preferences|Secure Preferences)$/i;
const sensitiveExtensions = /\.(?:dpapi|pem|key|pfx|p12|har|log|trace|zip|png|jpe?g|webp|mp4)$/i;
const failures = [];
let checked = 0;

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).split(path.sep).join('/');
    const top = relative.split('/')[0];
    if (entry.isSymbolicLink()) { failures.push({ file: relative, issue: 'linked-file-or-directory' }); continue; }
    if (sensitiveNames.test(entry.name) || sensitiveExtensions.test(entry.name)) { failures.push({ file: relative, issue: 'private-runtime-or-capture-file' }); continue; }
    if (!allowedDirectories.has(top) && !allowedFiles.has(relative)) { failures.push({ file: relative, issue: 'not-in-source-allowlist' }); continue; }
    if (entry.isDirectory()) { await scan(file); continue; }
    checked++;
    const content = await readFile(file, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      const add = issue => failures.push({ file: relative, line: index + 1, issue });
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) add('private-key');
      if (/\bcat-[a-f\d]{24,}\b/i.test(line)) add('credential-shaped-key');
      if (/\b(?:gh[pousr]_|github_pat_|AKIA)[A-Za-z\d_]{16,}/.test(line)) add('service-token');
      if (/[A-Z]:[\\/](?:Users|AaA|CodexHome)[\\/]/i.test(line)) add('personal-machine-path');
      for (const match of line.matchAll(/[A-Z\d._%+-]+@([A-Z\d.-]+\.[A-Z]{2,})/gi)) {
        if (!/^(?:example\.(?:com|org|net)|test\.invalid)$/i.test(match[1])) add('non-example-email');
      }
      for (const match of line.matchAll(/\bcat-[A-Za-z\d_-]{8,}/g)) {
        if (!/(?:^cat-(?:fake|test|example|placeholder)-)|(?:-test-)/.test(match[0])) add('unmarked-key-literal');
      }
      if (/\b(?:Bearer\s+[a-f\d]{32,}|eyJ[A-Za-z\d_-]{16,}\.[A-Za-z\d_-]{16,}\.[A-Za-z\d_-]{16,})/i.test(line)) add('auth-token');
    });
  }
}

await scan(root);
// An ignored file can still be tracked. Check the index as well when this is a repo root.
try {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  if (path.resolve(repoRoot).toLowerCase() === path.resolve(root).toLowerCase()) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of tracked) if (file.split('/').some(part => sensitiveNames.test(part)) || sensitiveExtensions.test(file)) failures.push({ file, issue: 'private-file-in-git-index' });
  }
} catch { /* A source-only copy need not be initialized as a Git repository yet. */ }

console.log(JSON.stringify({ ok: failures.length === 0, checkedFiles: checked, findings: failures }, null, 2));
if (failures.length) process.exitCode = 1;
