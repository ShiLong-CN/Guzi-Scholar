'use strict';

const assert = require('node:assert/strict');

const {
  checkForUpdate,
  compareVersions,
  validateUpdateManifest,
} = require('../electron/update-service.cjs');

const allowedOrigins = ['https://82.156.152.27', 'https://guzilab.com'];
const manifest = {
  schema: 1,
  version: '0.1.1',
  platform: 'darwin',
  arch: 'arm64',
  channel: 'beta',
  published_at: '2026-08-06T00:00:00Z',
  notes: '修复旧版文献库恢复。',
  download_url: 'https://82.156.152.27/updates/macos/arm64/Guzi-Scholar-0.1.1.dmg',
  sha256: 'a'.repeat(64),
};

async function main() {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0-beta.2', '0.1.0-beta.1'), 1);
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0'), -1);

  const validated = validateUpdateManifest(manifest, {
    platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
  });
  assert.equal(validated.version, '0.1.1');
  assert.equal(validated.downloadURL, manifest.download_url);
  assert.throws(
    () => validateUpdateManifest({ ...manifest, download_url: 'https://example.com/update.dmg' }, {
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
    }),
    /受信任/,
  );
  assert.throws(
    () => validateUpdateManifest({ ...manifest, arch: 'x64' }, {
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
    }),
    /不匹配/,
  );

  const available = await checkForUpdate({
    manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
    currentVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'beta',
    allowedOrigins,
    fetcher: async () => manifest,
  });
  assert.equal(available.status, 'available');
  assert.equal(available.version, '0.1.1');

  const current = await checkForUpdate({
    manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
    currentVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'beta',
    allowedOrigins,
    fetcher: async () => ({ ...manifest, version: '0.1.0', download_url: '', sha256: '' }),
  });
  assert.equal(current.status, 'current');

  await assert.rejects(
    checkForUpdate({
      manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
      currentVersion: '0.1.0',
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins,
      fetcher: async () => ({ ...manifest, sha256: '' }),
    }),
    /缺少下载地址或文件校验值/,
  );
  console.log('update service tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
