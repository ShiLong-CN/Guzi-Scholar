'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  consumeInstallationMarker,
  markerPath,
  noticeMarkerPath,
  requestMacInstallation,
  shouldOfferInstallation,
} = require('../electron/macos-installation.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'my-scholar-installation-'));

function fakeApp(overrides = {}) {
  return {
    isPackaged: true,
    isInApplicationsFolder: () => false,
    moveToApplicationsFolder: () => true,
    getPath: (name) => {
      assert.strictEqual(name, 'userData');
      return temporaryRoot;
    },
    ...overrides,
  };
}

function fakeDialog(answers = []) {
  const messages = [];
  const errors = [];
  return {
    messages,
    errors,
    showMessageBoxSync: (options) => {
      messages.push(options);
      return answers.length ? answers.shift() : 0;
    },
    showErrorBox: (...args) => errors.push(args),
  };
}

try {
  assert.strictEqual(shouldOfferInstallation(fakeApp(), 'darwin'), true);
  assert.strictEqual(shouldOfferInstallation(fakeApp({ isPackaged: false }), 'darwin'), false);
  assert.strictEqual(shouldOfferInstallation(fakeApp(), 'win32'), false);
  assert.strictEqual(shouldOfferInstallation(fakeApp({ isInApplicationsFolder: () => true }), 'darwin'), false);

  const developmentDialog = fakeDialog();
  assert.deepStrictEqual(requestMacInstallation({ app: fakeApp({ isPackaged: false }), dialog: developmentDialog, platform: 'darwin' }), { action: 'continue' });
  assert.strictEqual(developmentDialog.messages.length, 0);

  const declinedDialog = fakeDialog([1]);
  assert.deepStrictEqual(requestMacInstallation({ app: fakeApp(), dialog: declinedDialog, platform: 'darwin' }), { action: 'quit', reason: 'declined' });
  assert.strictEqual(fs.existsSync(markerPath(fakeApp())), false);

  const movingDialog = fakeDialog([0]);
  let moveOptions = null;
  const movingApp = fakeApp({ moveToApplicationsFolder: (options) => { moveOptions = options; return true; } });
  assert.deepStrictEqual(requestMacInstallation({ app: movingApp, dialog: movingDialog, platform: 'darwin' }), { action: 'moving' });
  assert.strictEqual(typeof moveOptions?.conflictHandler, 'function');
  assert.strictEqual(fs.existsSync(markerPath(movingApp)), true);
  movingApp.isInApplicationsFolder = () => true;
  assert.strictEqual(consumeInstallationMarker({ app: movingApp, platform: 'darwin' }), 'assisted');
  assert.strictEqual(fs.existsSync(noticeMarkerPath(movingApp)), true);
  assert.strictEqual(consumeInstallationMarker({ app: movingApp, platform: 'darwin' }), null);

  const manualRoot = path.join(temporaryRoot, 'manual-install');
  const manualApp = fakeApp({
    isInApplicationsFolder: () => true,
    getPath: () => manualRoot,
  });
  assert.strictEqual(consumeInstallationMarker({ app: manualApp, platform: 'darwin' }), 'manual');
  assert.strictEqual(consumeInstallationMarker({ app: manualApp, platform: 'darwin' }), null);

  const conflictDialog = fakeDialog([0, 1]);
  const conflictApp = fakeApp({ moveToApplicationsFolder: ({ conflictHandler }) => { conflictHandler('exists'); return false; } });
  assert.deepStrictEqual(requestMacInstallation({ app: conflictApp, dialog: conflictDialog, platform: 'darwin' }), { action: 'quit', reason: 'cancelled' });
  assert.strictEqual(fs.existsSync(markerPath(conflictApp)), false);

  const failureDialog = fakeDialog([0]);
  const failureApp = fakeApp({ moveToApplicationsFolder: () => { throw new Error('copy failed'); } });
  const failure = requestMacInstallation({ app: failureApp, dialog: failureDialog, platform: 'darwin' });
  assert.strictEqual(failure.action, 'quit');
  assert.strictEqual(failure.reason, 'failed');
  assert.strictEqual(failureDialog.errors.length, 1);
  assert.strictEqual(fs.existsSync(markerPath(failureApp)), false);

  console.log('macOS installation flow tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
