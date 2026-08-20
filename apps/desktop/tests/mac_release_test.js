'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const resources = new Map((manifest.build?.extraResources || []).map((entry) => [entry.to, entry.from]));

function readPngSize(file) {
  const image = fs.readFileSync(file);
  assert.deepStrictEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

assert.strictEqual(manifest.build?.appId, 'com.guzi.scholar');
assert.strictEqual(manifest.build?.productName, '谷子学术');
assert.strictEqual(manifest.build?.directories?.output, 'dist/mac.noindex');
assert.strictEqual(manifest.build?.mac?.extendInfo?.CFBundleDisplayName, '谷子学术');
assert.strictEqual(manifest.build?.mac?.extendInfo?.CFBundleName, '谷子学术');
assert.strictEqual(manifest.version, '0.1.0');
assert.strictEqual(manifest.build?.afterPack, 'scripts/after-pack.cjs');
assert.match(manifest.scripts?.['pack:mac'] || '', /prepare:mac/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /prepare:mac/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /build-mac-target\.cjs dmg release/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /build-mac-target\.cjs check release/u);
assert.match(manifest.scripts?.['dist:mac:internal'] || '', /build-mac-target\.cjs dmg internal/u);
assert.strictEqual(resources.get('python-server'), 'build/mac-runtime/my-scholar-server');
assert.strictEqual(resources.get('java'), 'build/mac-runtime/java');
assert.strictEqual(resources.get('toolchain/opendataloader-pdf-cli-0.0.0.jar'), 'build/mac-runtime/opendataloader-pdf-cli-0.0.0.jar');
assert.strictEqual(resources.get('toolchain/pdf-renderer'), 'build/mac-runtime/pdf-renderer');
assert.strictEqual(manifest.build?.dmg?.background, 'resources/dmg-background.png');
assert.deepStrictEqual(manifest.build?.dmg?.window, { width: 720, height: 530 });
assert.strictEqual(manifest.build?.dmg?.contents?.[0]?.x, 168);
assert.strictEqual(manifest.build?.dmg?.contents?.[1]?.path, '/Applications');
assert.ok(fs.existsSync(path.join(root, 'resources', 'dmg-background.svg')), 'the branded DMG background source must be kept with the package');
assert.deepStrictEqual(readPngSize(path.join(root, 'resources', 'dmg-background.png')), { width: 720, height: 530 });
assert.deepStrictEqual(readPngSize(path.join(root, 'resources', 'dmg-background@2x.png')), { width: 1440, height: 1060 });
const dmgBackgroundSource = fs.readFileSync(path.join(root, 'resources', 'dmg-background.svg'), 'utf8');
assert.doesNotMatch(dmgBackgroundSource, /先双击.*尝试打开/u, 'the DMG must not ask users to launch the uninstalled app first');
assert.match(dmgBackgroundSource, /从“应用程序”打开“谷子学术”/u);

const afterPackSource = fs.readFileSync(path.join(root, 'scripts', 'after-pack.cjs'), 'utf8');
for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription']) {
  assert.match(afterPackSource, new RegExp(key), `${key} must be removed from the packaged Info.plist`);
}
assert.match(afterPackSource, /NSAllowsArbitraryLoads: false/u);

const buildMacSource = fs.readFileSync(path.join(root, 'scripts', 'build-mac-target.cjs'), 'utf8');
assert.match(buildMacSource, /Developer ID Application:/u);
assert.match(buildMacSource, /APPLE_KEYCHAIN_PROFILE/u);
assert.match(buildMacSource, /--config\.mac\.identity=-/u);
assert.match(buildMacSource, /--config\.mac\.hardenedRuntime=false/u);
assert.match(buildMacSource, /\.metadata_never_index/u);

const prepareMacSource = fs.readFileSync(path.join(root, 'scripts', 'prepare-mac-release.sh'), 'utf8');
assert.match(prepareMacSource, /import certifi; print\(certifi\.where\(\)\)/u);
assert.match(prepareMacSource, /my-scholar-server\/\$\{CA_BUNDLE_NAME\}/u);
assert.match(prepareMacSource, /test -s "\$\{RUNTIME_DIR\}\/my-scholar-server\/\$\{CA_BUNDLE_NAME\}"/u);

const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
assert.match(mainSource, /app\.setName\(PRODUCT_NAME\)/u);
assert.match(mainSource, /!app\.isPackaged[\s\S]*\$\{defaultUserDataPath\}-development/u);
assert.match(mainSource, /app\.isPackaged[\s\S]*python-server[\s\S]*my-scholar-server/u);
assert.match(mainSource, /packagedToolchainEnvironment[\s\S]*MY_SCHOLAR_ODL_JAR[\s\S]*MY_SCHOLAR_JAVA[\s\S]*MY_SCHOLAR_PDF_RENDERER_CLASSPATH/u);
assert.match(mainSource, /python-server[\s\S]*ca-certificates\.crt[\s\S]*SSL_CERT_FILE: caBundle/u);
assert.match(mainSource, /stats\.isFile\(\) && stats\.size > 0/u);
assert.match(mainSource, /MY_SCHOLAR_PROJECT_ROOT: projectRoot/u);
assert.match(mainSource, /requestMacInstallation\(\{ app, dialog \}\)/u);
assert.match(mainSource, /consumeInstallationMarker\(\{ app \}\)/u);
assert.match(mainSource, /安装程序已自动退出/u);
assert.match(mainSource, /关闭并推出安装镜像/u);

const serverSource = fs.readFileSync(path.join(root, 'server.py'), 'utf8');
const pipelineSource = fs.readFileSync(path.join(root, 'pipeline.py'), 'utf8');
assert.match(serverSource, /MY_SCHOLAR_PROJECT_ROOT/u);
assert.match(pipelineSource, /MY_SCHOLAR_JAVA/u);
assert.match(fs.readFileSync(path.join(root, 'layout_pipeline.py'), 'utf8'), /MY_SCHOLAR_PDF_RENDERER_CLASSPATH/u);

console.log('mac release integration tests passed');
