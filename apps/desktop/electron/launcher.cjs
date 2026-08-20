const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { libraryPointerPath, resolveLibraryLocation } = require('./library-storage.cjs');
const { resolvePythonRuntime } = require('./python-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');
const electron = require('electron');
const allowBrowserFallback = !['0', 'false', 'no'].includes(String(process.env.MY_SCHOLAR_BROWSER_FALLBACK || '1').toLowerCase());
const launchPreference = String(process.env.MY_SCHOLAR_ELECTRON_LAUNCH || '').trim().toLowerCase();
// macOS can abort GUI processes spawned from a Codex sandbox while AppKit is
// registering the application. LaunchServices gives the app a normal GUI
// parent (launchd) and avoids that system-level failure. Direct spawn remains
// available for CI and debugging via MY_SCHOLAR_ELECTRON_LAUNCH=direct.
const useLaunchServices = process.platform === 'darwin'
  && !['direct', 'spawn'].includes(launchPreference)
  && launchPreference !== 'browser';

let desktop = null;
let browserServer = null;
let stopping = false;
let fallbackStarted = false;

function stop(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    // SIGTERM is TerminateProcess here: Electron never runs its quit
    // handlers, so its Python child would outlive us and keep the library
    // lock. Kill the tree instead.
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      return;
    } catch (_) { /* fall through to the portable path */ }
  }
  child.kill('SIGTERM');
}

function startBrowserFallback(reason) {
  if (fallbackStarted || stopping) return;
  fallbackStarted = true;
  if (reason) console.error(`Electron 桌面壳未能启动，切换到本地浏览器阅读器：${reason}`);
  const stateDir = path.resolve(process.env.MY_SCHOLAR_DATA_DIR || path.join(projectRoot, 'data'));
  let location;
  try {
    location = resolveLibraryLocation({ defaultLibraryDir: stateDir, pointerPath: libraryPointerPath(stateDir), env: process.env });
  } catch (error) {
    console.error(`${error.message || error} 已停止浏览器回退，避免写入旧文献库。`);
    process.exitCode = 1;
    return;
  }
  if (location.source === 'saved') {
    try {
      const info = fs.lstatSync(location.currentPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a local directory');
    } catch (_) {
      console.error('自定义文献库位置不可用。请重新连接原磁盘或恢复该文件夹；如需改到其他位置，请恢复后在“设置 > 文献管理”中重新选择。已停止浏览器回退，避免写入旧文献库。');
      process.exitCode = 1;
      return;
    }
  }
  let python;
  try {
    python = resolvePythonRuntime({
      env: process.env,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      appPath: projectRoot,
    });
  } catch (error) {
    console.error(`找不到可用的 Python 运行环境：${error.message}`);
    process.exitCode = 1;
    return;
  }
  const env = {
    ...process.env,
    MY_SCHOLAR_DATA_DIR: stateDir,
    MY_SCHOLAR_LIBRARY_DIR: location.currentPath,
    MY_SCHOLAR_API_TOKEN: '',
    MY_SCHOLAR_BACKEND: process.env.MY_SCHOLAR_BACKEND || 'auto',
  };
  browserServer = spawn(python.command, [...python.args, path.join(projectRoot, 'server.py'), '--host', '127.0.0.1', '--port', '0'], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  browserServer.once('error', (error) => {
    console.error(`本地浏览器服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  browserServer.once('exit', (code, signal) => {
    browserServer = null;
    if (!stopping && code !== 0) process.exitCode = code || 1;
  });
}

function start() {
  if (useLaunchServices) {
    // Do not use `open -W`: killing the waiting `open` process does not quit
    // the LaunchServices-owned Electron process, which would leave the local
    // Python server running after Ctrl-C. The desktop process owns its server
    // and is intentionally detached from the terminal instead.
    desktop = spawn('/usr/bin/open', ['-n', '-a', path.dirname(path.dirname(path.dirname(electron))), '--args', projectRoot], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
  } else if (launchPreference === 'browser') {
    startBrowserFallback('MY_SCHOLAR_ELECTRON_LAUNCH=browser');
    return;
  } else {
    desktop = spawn(electron, [projectRoot], { cwd: projectRoot, env: process.env, stdio: 'inherit' });
  }
  desktop.once('error', (error) => {
    if (allowBrowserFallback) startBrowserFallback(error.message);
    else {
      console.error(`Electron 启动失败：${error.message}`);
      process.exitCode = 1;
    }
  });
  desktop.once('exit', (code, signal) => {
    desktop = null;
    if (stopping) return;
    if (code === 0 && !signal) {
      if (!browserServer) process.exit(0);
      return;
    }
    if (allowBrowserFallback) startBrowserFallback(signal ? `signal ${signal}` : `exit ${code}`);
    else process.exitCode = code || 1;
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    stop(desktop);
    stop(browserServer);
  });
}

start();
