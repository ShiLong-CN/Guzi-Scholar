'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const tests = [
  ['document', 'web_smoke.js'],
  ['features', 'feature_smoke.js'],
  ['translation', 'translation_smoke.js'],
  ['library', 'library_smoke.js'],
  ['library-v3', 'library_v3_smoke.js'],
  ['interactions', 'interaction_regression.js'],
  ['library-v4', 'library_interactions_v4.js'],
  ['reading-progress', 'reading_progress_retirement_smoke.js'],
  ['graph', 'graph_ui_smoke.js'],
  ['onboarding', 'onboarding_smoke.js'],
];
const results = [];

for (const [name, script] of tests) {
  console.log(`\n[macOS UI ${results.length + 1}/${tests.length}] ${name}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), baseURL], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  const passed = result.status === 0 && !result.signal;
  results.push({ name, passed, status: result.status, signal: result.signal || null });
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((result) => result.name) }));
if (failed.length) process.exitCode = 1;
