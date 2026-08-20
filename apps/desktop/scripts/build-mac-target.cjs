'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outputDirectory = path.join(root, 'dist', 'mac.noindex');

function preventBuildOutputIndexing() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.closeSync(fs.openSync(path.join(outputDirectory, '.metadata_never_index'), 'a', 0o600));
}

function main() {
  const target = process.argv[2];
  const mode = process.argv[3];
  if (!['check', 'dir', 'dmg'].includes(target) || !['internal', 'release'].includes(mode)) {
    console.error('usage: node scripts/build-mac-target.cjs <check|dir|dmg> <internal|release>');
    return 1;
  }

  if (mode === 'release') {
    const identities = spawnSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    );
    const output = `${identities.stdout || ''}\n${identities.stderr || ''}`;
    const hasLinkedIdentity = Boolean(process.env.CSC_LINK?.trim());
    if (!hasLinkedIdentity && (identities.status !== 0 || !output.includes('Developer ID Application:'))) {
      console.error(
        '正式 macOS 发布需要 Developer ID Application 证书。当前未找到有效证书；请使用 npm run dist:mac:internal 生成内部测试包。',
      );
      return 1;
    }

    const hasAppleIdCredentials = [
      process.env.APPLE_ID,
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      process.env.APPLE_TEAM_ID,
    ].every((value) => Boolean(value?.trim()));
    const hasApiKeyCredentials = [
      process.env.APPLE_API_KEY,
      process.env.APPLE_API_KEY_ID,
      process.env.APPLE_API_ISSUER,
    ].every((value) => Boolean(value?.trim()));
    const hasKeychainProfile = Boolean(process.env.APPLE_KEYCHAIN_PROFILE?.trim());
    if (!hasAppleIdCredentials && !hasApiKeyCredentials && !hasKeychainProfile) {
      console.error('正式 macOS 发布还需要完整的 Apple 公证凭据；内部测试请使用 npm run dist:mac:internal。');
      return 1;
    }
  }

  if (target === 'check') return 0;

  preventBuildOutputIndexing();
  const args = ['--mac', target, '--arm64', '--publish=never'];
  if (mode === 'internal') {
    args.push(
      '--config.mac.identity=-',
      '--config.mac.hardenedRuntime=false',
      '--config.artifactName=Guzi-Scholar-${version}-${arch}-internal.${ext}',
    );
  }

  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
  const result = spawnSync(builder, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  preventBuildOutputIndexing();
  return result.status ?? 1;
}

process.exitCode = main();
