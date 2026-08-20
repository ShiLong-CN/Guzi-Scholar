'use strict';

const fs = require('fs');
const path = require('path');

const INSTALLATION_MARKER = '.installation-complete-v1';
const INSTALLATION_NOTICE_MARKER = '.installation-notice-shown-v1';

function markerPath(app) {
  return path.join(app.getPath('userData'), INSTALLATION_MARKER);
}

function noticeMarkerPath(app) {
  return path.join(app.getPath('userData'), INSTALLATION_NOTICE_MARKER);
}

function markerExists(target, filesystem = fs) {
  try {
    filesystem.accessSync(target, filesystem.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function removeMarker(app, filesystem = fs) {
  try {
    filesystem.unlinkSync(markerPath(app));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeMarker(app, filesystem = fs) {
  const target = markerPath(app);
  filesystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  filesystem.writeFileSync(target, JSON.stringify({ version: 1 }), { encoding: 'utf8', mode: 0o600 });
}

function writeNoticeMarker(app, filesystem = fs) {
  const target = noticeMarkerPath(app);
  filesystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  filesystem.writeFileSync(target, JSON.stringify({ version: 1 }), { encoding: 'utf8', mode: 0o600 });
}

function shouldOfferInstallation(app, platform = process.platform) {
  return platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();
}

function consumeInstallationMarker({ app, platform = process.platform, filesystem = fs }) {
  if (platform !== 'darwin' || !app.isPackaged || !app.isInApplicationsFolder()) return null;
  const assisted = markerExists(markerPath(app), filesystem);
  if (assisted) removeMarker(app, filesystem);
  if (!assisted && markerExists(noticeMarkerPath(app), filesystem)) return null;
  try {
    writeNoticeMarker(app, filesystem);
  } catch (_) {
    // A read-only user data directory will be reported by normal startup; the
    // installation itself is still complete, so keep the confirmation useful.
  }
  return assisted ? 'assisted' : 'manual';
}

function requestMacInstallation({ app, dialog, platform = process.platform, filesystem = fs }) {
  if (!shouldOfferInstallation(app, platform)) return { action: 'continue' };
  removeMarker(app, filesystem);
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: '安装谷子学术',
    message: '先将谷子学术安装到“应用程序”',
    detail: '点击“安装并打开”后，谷子学术会复制到“应用程序”。安装完成后，此安装进程会自动退出，并从安装位置重新打开。',
    buttons: ['安装并打开', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice !== 0) return { action: 'quit', reason: 'declined' };

  let conflictCancelled = false;
  try {
    writeMarker(app, filesystem);
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === 'existsAndRunning') {
          conflictCancelled = true;
          dialog.showMessageBoxSync({
            type: 'warning',
            title: '请先退出已安装的谷子学术',
            message: '“应用程序”中的谷子学术正在运行',
            detail: '请完全退出正在运行的版本，再重新打开此安装包。你的设置与本地文献不会被删除。',
            buttons: ['知道了'],
            defaultId: 0,
          });
          return false;
        }
        const replace = dialog.showMessageBoxSync({
          type: 'question',
          title: '替换已有版本？',
          message: '“应用程序”中已有谷子学术',
          detail: '替换应用不会删除你的设置或本地文献。',
          buttons: ['替换并继续', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }) === 0;
        conflictCancelled = !replace;
        return replace;
      },
    });
    if (moved) return { action: 'moving' };
    removeMarker(app, filesystem);
    if (!conflictCancelled) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: '安装未完成',
        message: '谷子学术尚未安装到“应用程序”',
        detail: '你可以重新打开安装包后再试一次。',
        buttons: ['知道了'],
        defaultId: 0,
      });
    }
    return { action: 'quit', reason: 'cancelled' };
  } catch (error) {
    removeMarker(app, filesystem);
    dialog.showErrorBox('谷子学术安装失败', `${error.message || '无法复制到“应用程序”。'}\n\n你也可以回到安装窗口，将谷子学术手动拖入“应用程序”。`);
    return { action: 'quit', reason: 'failed', error };
  }
}

module.exports = {
  consumeInstallationMarker,
  markerPath,
  noticeMarkerPath,
  requestMacInstallation,
  shouldOfferInstallation,
};
