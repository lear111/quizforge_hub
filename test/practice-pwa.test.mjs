import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPracticeApp } from '../practice/server/app.mjs';
import { HubLogin } from '../practice/server/cloud/hub-login.mjs';
import { practiceInstallHead, practiceManifestUrl } from '../practice/server/cloud/pwa.mjs';

const runtime = process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-current', import.meta.url));
const enabled = fs.existsSync(path.join(runtime, 'snapshot.json'));
const head = `<!doctype html><head>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/svg+xml" href="/assets/quizforge-icon.svg">
<link rel="apple-touch-icon" href="/assets/quizforge-touch-icon.png">
</head>`;

test('cloud installation links stay public when the practice renderer prefixes workspace assets', () => {
  const adapted = practiceInstallHead(head).replace(/\b(href|src)="\/(?!\/|cloud\/|auth\/)/g, '$1="/cloud/practice/11111111-1111-4111-8111-111111111111/');
  assert.match(adapted, /href="\/cloud\/pwa\/manifest.webmanifest"/);
  assert.doesNotMatch(adapted, /cloud\/practice\//);
  assert.match(adapted, /icons\/quizforge-icon-192.png" sizes="192x192" type="image\/png"/);
  assert.match(adapted, /apple-touch-icon" href="\/cloud\/pwa\/icons\/quizforge-touch-icon.png"/);
  assert.throws(() => practiceInstallHead('<head></head>'), /manifest link changed/);
});

test('anonymous installation assets bypass session lookup but preserve the host gate and private practice boundary', { skip: !enabled }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-pwa-'));
  let authCalls = 0, failIdentity = false, gateCalls = 0, login;
  const app = await createPracticeApp({ dataDir: directory, cloudRuntimeDir: runtime, practiceHome: true,
    beforeRequest: async (req, res, url) => { gateCalls++; return login.handle(req, res, url); },
    identityProvider: async () => { authCalls++; if (failIdentity) throw new Error('Synthetic identity outage'); return null; },
  });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  login = new HubLogin({ practiceOrigin: origin, hubOrigin: 'https://hub.example.test', authPort: 1 });
  const request = (route, options = {}) => fetch(origin + route, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options });
  let manifest;

  await t.test('manifest is the same anonymous JSON with no cookies, stale cookies or an unavailable identity provider', async () => {
    failIdentity = true;
    const anonymous = await request(practiceManifestUrl), signed = await request(practiceManifestUrl, { headers: { Cookie: '__Host-qfh_practice=' + 'a'.repeat(64) } });
    assert.equal(anonymous.status, 200); assert.equal(signed.status, 200);
    assert.match(anonymous.headers.get('content-type'), /^application\/manifest\+json/);
    assert.equal(anonymous.headers.get('location'), null); assert.equal(anonymous.headers.get('set-cookie'), null);
    assert.equal(anonymous.headers.get('cache-control'), 'no-cache');
    const bytes = await anonymous.text(); assert.equal(bytes, await signed.text()); manifest = JSON.parse(bytes);
    assert.equal(manifest.id, '/'); assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/'); assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.name, 'QuizForge Hub'); assert.doesNotMatch(bytes, /cloud\/practice\/|user_id|token/);
    assert.equal(authCalls, 0); assert.equal(gateCalls, 2);
    const response = await request(practiceManifestUrl, { method: 'HEAD' }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(bytes))); assert.equal(await response.text(), '');
  });

  await t.test('all installation icons are anonymous original bytes with correct 192/512 PNG dimensions', async () => {
    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\/cloud\/pwa\/icons\/[^/]+\.png$/);
      const response = await request(icon.src); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('set-cookie'), null);
      const bytes = Buffer.from(await response.arrayBuffer()), filename = icon.src.split('/').at(-1);
      assert.deepEqual(bytes, fs.readFileSync(path.join(runtime, 'core/web/assets', filename)));
      assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
      const responseHead = await request(icon.src, { method: 'HEAD' }); assert.equal(responseHead.status, 200);
      assert.equal(responseHead.headers.get('content-length'), String(bytes.length)); assert.equal(await responseHead.text(), '');
    }
    for (const filename of ['quizforge-icon.svg', 'quizforge-touch-icon.png']) assert.equal((await request('/cloud/pwa/icons/' + filename)).status, 200);
    assert.equal(authCalls, 0);
  });

  await t.test('public paths allow no writes or arbitrary runtime/user files', async () => {
    for (const route of [practiceManifestUrl, manifest.icons[0].src]) {
      const response = await request(route, { method: 'POST', body: 'synthetic' }); assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
    for (const route of ['/cloud/pwa/icons/unknown.png', '/cloud/pwa/icons/manifest.webmanifest', '/cloud/pwa/icons/server.js', '/cloud/pwa/icons/nested/quizforge-icon.png', '/cloud/pwa/icons/%5c..%5capp.mjs', '/cloud/pwa/snapshot.json']) {
      assert.equal((await request(route)).status, 404);
    }
    assert.equal(authCalls, 0);
  });

  await t.test('host validation still runs before the public route', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(origin + practiceManifestUrl, { headers: { Host: 'evil.example.test' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
    assert.equal(status, 403); assert.equal(authCalls, 0);
  });

  await t.test('startup requires login and all private practice/API paths remain protected', async () => {
    failIdentity = false;
    const startup = await request(manifest.start_url); assert.equal(startup.status, 303); assert.equal(startup.headers.get('location'), '/auth/hub');
    const privateBase = '/cloud/practice/11111111-1111-4111-8111-111111111111/';
    for (const suffix of ['', 'manifest.webmanifest', 'assets/quizforge-icon.png']) {
      const response = await request(privateBase + suffix); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/auth/hub');
    }
    for (const route of ['/api/cloud/me', '/api/cloud/library', '/api/cloud/practice/11111111-1111-4111-8111-111111111111/api/catalog']) assert.equal((await request(route)).status, 401);
    const visits = authCalls;
    assert.equal((await request(practiceManifestUrl)).status, 200); assert.equal(authCalls, visits);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM cloud_imports').get().n, 0);
  });
});

test('non ordinary practice instances do not expose the public install route', { skip: !enabled }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-pwa-legacy-'));
  const app = await createPracticeApp({ dataDir: directory, cloudRuntimeDir: runtime, practiceHome: false, identityProvider: async () => null });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${practiceManifestUrl}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.notEqual(response.status, 200);
});
