const { spawnSync } = require('child_process');
const path = require('path');

const MINIMUM_PYTHON = Object.freeze({ major: 3, minor: 9 });
const PROBE_SCRIPT = [
  'import hashlib, json, ssl, sqlite3, sys, urllib.request',
  'assert hasattr(hashlib, "scrypt")',
  'print(json.dumps({"major": sys.version_info[0], "minor": sys.version_info[1], "micro": sys.version_info[2]}))',
].join('; ');

class PythonRuntimeError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'PythonRuntimeError';
    this.attempts = attempts;
  }
}

function versionSupported(version) {
  if (!version) return false;
  return version.major > MINIMUM_PYTHON.major
    || (version.major === MINIMUM_PYTHON.major && version.minor >= MINIMUM_PYTHON.minor);
}

function probePython(candidate, { spawnSyncImpl = spawnSync } = {}) {
  let result;
  try {
    result = spawnSyncImpl(candidate.command, [...candidate.args, '-c', PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
  if (result.error) return { ok: false, reason: result.error.message || String(result.error) };
  if (result.status !== 0) {
    const details = `${result.stderr || ''}${result.stdout || ''}`.trim();
    return { ok: false, reason: details || `exit ${result.status}` };
  }
  try {
    const lines = String(result.stdout || '').trim().split(/\r?\n/u);
    const version = JSON.parse(lines[lines.length - 1]);
    if (!versionSupported(version)) {
      return { ok: false, reason: `Python ${version.major}.${version.minor} 低于 3.9` };
    }
    return { ok: true, version };
  } catch (_) {
    return { ok: false, reason: '无法解析 Python 能力探测结果' };
  }
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = JSON.stringify([candidate.command, candidate.args]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pythonCandidates({
  env = process.env,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  appPath = '',
} = {}) {
  const configured = String(env.MY_SCHOLAR_PYTHON || '').trim();
  if (configured) return [{ command: configured, args: [], source: 'MY_SCHOLAR_PYTHON' }];

  const candidates = [];
  if (resourcesPath) {
    candidates.push(
      { command: path.join(resourcesPath, 'python', 'bin', 'python3'), args: [], source: 'bundled-python' },
      { command: path.join(resourcesPath, 'python-runtime', 'bin', 'python3'), args: [], source: 'bundled-python-runtime' },
    );
  }
  if (appPath) {
    candidates.push({ command: path.join(appPath, 'runtime', 'python', 'bin', 'python3'), args: [], source: 'app-python-runtime' });
  }
  if (platform === 'darwin') {
    candidates.push(
      { command: '/opt/homebrew/bin/python3', args: [], source: 'homebrew-apple-silicon' },
      { command: '/usr/local/bin/python3', args: [], source: 'homebrew-intel' },
      { command: '/usr/bin/python3', args: [], source: 'macos-system' },
    );
  } else if (platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'], source: 'windows-launcher' });
  }
  candidates.push(
    { command: 'python3', args: [], source: 'path-python3' },
    { command: 'python', args: [], source: 'path-python' },
  );
  return uniqueCandidates(candidates);
}

function resolvePythonRuntime(options = {}) {
  const candidates = pythonCandidates(options);
  const attempts = [];
  for (const candidate of candidates) {
    const probe = probePython(candidate, options);
    if (probe.ok) return { ...candidate, version: probe.version };
    attempts.push({ ...candidate, reason: probe.reason });
  }
  const configured = String((options.env || process.env).MY_SCHOLAR_PYTHON || '').trim();
  const hint = configured
    ? `MY_SCHOLAR_PYTHON 指向的解释器不可用：${configured}`
    : '未找到具备 hashlib.scrypt、ssl、sqlite3 和网络标准库的 Python 3.9 或更高版本。';
  throw new PythonRuntimeError(hint, attempts);
}

module.exports = {
  MINIMUM_PYTHON,
  PythonRuntimeError,
  probePython,
  pythonCandidates,
  resolvePythonRuntime,
  versionSupported,
};
