const assert = require('assert');
const {
  PythonRuntimeError,
  probePython,
  pythonCandidates,
  resolvePythonRuntime,
  versionSupported,
} = require('../electron/python-runtime.cjs');

function successfulProbe(version = { major: 3, minor: 11, micro: 9 }) {
  return { status: 0, stdout: `${JSON.stringify(version)}\n`, stderr: '' };
}

assert.equal(versionSupported({ major: 3, minor: 9 }), true);
assert.equal(versionSupported({ major: 3, minor: 8 }), false);

{
  let probeScript = '';
  const result = probePython(
    { command: 'python3', args: [], source: 'test' },
    { spawnSyncImpl: (_command, args) => { probeScript = args.at(-1); return { status: 1, stdout: '', stderr: 'missing scrypt' }; } },
  );
  assert.match(probeScript, /hashlib[\s\S]*scrypt/u);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing scrypt/u);
}

{
  const candidates = pythonCandidates({
    env: {},
    platform: 'darwin',
    resourcesPath: '/App/Contents/Resources',
    appPath: '/App/Contents/Resources/app',
  });
  assert.equal(candidates[0].command, '/App/Contents/Resources/python/bin/python3');
  assert.equal(candidates[0].source, 'bundled-python');
  assert(candidates.some((candidate) => candidate.command === '/opt/homebrew/bin/python3'));
}

{
  const calls = [];
  const runtime = resolvePythonRuntime({
    env: { MY_SCHOLAR_PYTHON: '/custom/python3' },
    platform: 'darwin',
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return successfulProbe();
    },
  });
  assert.equal(runtime.command, '/custom/python3');
  assert.equal(runtime.source, 'MY_SCHOLAR_PYTHON');
  assert.equal(calls.length, 1);
}

{
  const result = probePython(
    { command: 'python3', args: [], source: 'test' },
    { spawnSyncImpl: () => successfulProbe({ major: 3, minor: 8, micro: 20 }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /低于 3\.9/u);
}

{
  let thrown = null;
  try {
    resolvePythonRuntime({
      env: { MY_SCHOLAR_PYTHON: '/missing/python3' },
      platform: 'darwin',
      spawnSyncImpl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof PythonRuntimeError);
  assert.match(thrown.message, /MY_SCHOLAR_PYTHON/u);
  assert.equal(thrown.attempts.length, 1);
}

console.log('python runtime tests passed');
