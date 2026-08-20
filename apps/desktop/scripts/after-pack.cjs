'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const productName = context.packager.appInfo.productFilename;
  const infoPath = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Info.plist');
  for (const key of UNUSED_PERMISSION_KEYS) {
    try { execFileSync('/usr/bin/plutil', ['-remove', key, infoPath], { stdio: 'ignore' }); } catch (_) { /* The Electron template may stop adding this key. */ }
  }
  const transportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true,
    NSExceptionDomains: {
      '127.0.0.1': { NSIncludesSubdomains: false, NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
      localhost: { NSIncludesSubdomains: false, NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
    },
  };
  execFileSync('/usr/bin/plutil', ['-replace', 'NSAppTransportSecurity', '-json', JSON.stringify(transportSecurity), infoPath]);
};
