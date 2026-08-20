'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');

const configured = String(process.env.MY_SCHOLAR_TEST_PYTHON || '').trim();
const candidates = [
  configured,
  '/opt/anaconda3/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  'python3',
].filter(Boolean);

let python = null;
for (const candidate of candidates) {
  if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
  const probe = spawnSync(candidate, ['-c', 'import hashlib, sqlite3; assert hasattr(hashlib, "scrypt")'], {
    encoding: 'utf8',
    timeout: 8000,
  });
  if (probe.status === 0) {
    python = candidate;
    break;
  }
}

if (!python) {
  console.error('完整测试需要具备 hashlib.scrypt 与 sqlite3 的 Python；可通过 MY_SCHOLAR_TEST_PYTHON 指定。');
  process.exit(1);
}

const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
