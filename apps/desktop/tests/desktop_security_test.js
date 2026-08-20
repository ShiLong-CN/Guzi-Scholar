'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { hasTrustedOrigin } = require('../electron/url-security.cjs');

const serverURL = 'http://127.0.0.1:8766/';
assert.strictEqual(hasTrustedOrigin('http://127.0.0.1:8766/#settings-metadata', serverURL), true);
assert.strictEqual(hasTrustedOrigin('http://127.0.0.1:8766/api/library', serverURL), true);
assert.strictEqual(hasTrustedOrigin('http://127.0.0.1:8766@evil.example/', serverURL), false);
assert.strictEqual(hasTrustedOrigin('http://127.0.0.1.evil.example:8766/', serverURL), false);
assert.strictEqual(hasTrustedOrigin('https://127.0.0.1:8766/', serverURL), false);
assert.strictEqual(hasTrustedOrigin('not a URL', serverURL), false);

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
assert.match(mainSource, /event\.senderFrame !== mainFrame/u, 'desktop IPC must reject subframes and stale navigations');
assert.match(mainSource, /hasTrustedOrigin\(event\.senderFrame\?\.url, serverURL\)/u, 'desktop IPC must verify the live renderer origin');
assert.match(mainSource, /will-redirect/u, 'redirects must use the same origin guard as direct navigation');
assert.match(mainSource, /prepareAttempted = true;[\s\S]*backendMigrationControl\('prepare'\)/u, 'migration must remember that prepare may have reached the server');
assert.match(mainSource, /\(prepareAttempted \|\| requestsQuiesced\) && !serverWasStopped/u, 'every failed prepare must attempt to reopen the request gate');
assert.match(mainSource, /apiAccessToken = crypto\.randomBytes\(32\)\.toString\('hex'\)/u, 'desktop API access must use a high-entropy per-launch token');
assert.match(mainSource, /MY_SCHOLAR_API_TOKEN: apiAccessToken/u, 'the Python service must receive the desktop API token');
assert.match(mainSource, /'X-My-Scholar-Api-Token': apiAccessToken/u, 'main-process backend requests must authenticate');
assert.match(mainSource, /onBeforeSendHeaders[\s\S]*hasTrustedOrigin\(details\.url, serverURL\)[\s\S]*X-My-Scholar-Api-Token/u, 'trusted renderer requests must receive the API token without exposing it to renderer JavaScript');
assert.match(mainSource, /async function createWindow\(\)[\s\S]*if \(libraryMigrationPromise\)[\s\S]*await libraryMigrationPromise;[\s\S]*const url = await startServer\(\)/u, 'a new window must wait for migration or rollback before starting a service');
assert.match(mainSource, /flushRendererState\(\)[\s\S]*\.then\(\(\) => stopServer\(\)\)/u, 'quit must flush renderer settings and notes before stopping the local service');
assert.match(mainSource, /render-process-gone[\s\S]*shuttingDown = true;[\s\S]*stopServer\(\)[\s\S]*allowQuit = true;[\s\S]*app\.quit\(\)/u, 'a crashed renderer must stop the backend and quit without attempting to flush the dead renderer');
assert.match(mainSource, /render-process-gone[\s\S]*allowQuit \|\| rendererCrashShutdownPromise[\s\S]*rendererCrashShutdownPromise = stopServer\(\)/u, 'a renderer crash during an ordinary safe-quit flush must take over shutdown instead of being ignored');
assert.match(mainSource, /my-scholar:state-load[\s\S]*handleRendererStateIPC/u, 'desktop renderer state loads must pass through the authenticated IPC guard');
assert.match(mainSource, /new RendererStateStore\(path\.join\(storageConfiguration\(\)\.stateDir, 'renderer-state'\)\)/u, 'renderer state must live under the stable desktop state root');
assert.match(mainSource, /my-scholar:open-update-download'[\s\S]*availableUpdate\?\.downloadURL[\s\S]*shell\.openExternal\(availableUpdate\.downloadURL/u, 'update downloads must open only the main-process manifest result');
assert.doesNotMatch(mainSource, /my-scholar:open-update-download', async \(event,\s*(?:url|downloadURL)/u, 'the renderer must not supply an update download URL');
assert.match(mainSource, /const candidates = \[startupStorageReport\.current, \.\.\.\(startupStorageReport\.legacy \|\| \[\]\)\]/u, 'startup library selection must stay inside the directories inspected by the main process');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
assert.match(preloadSource, /state: Object\.freeze[\s\S]*my-scholar:state-load[\s\S]*my-scholar:state-set[\s\S]*my-scholar:state-remove/u, 'the isolated preload must expose only the bounded renderer state operations');
const webSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
assert.match(webSource, /window\.__myScholarFlushBeforeClose[\s\S]*flushPendingArticleNotes[\s\S]*flushPendingSettings[\s\S]*flushPendingChatSessions/u, 'the renderer must expose one awaited close flush for notes, settings, and Chat');

console.log('desktop security tests passed');
