import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { HubLogin } from '../cloud/hub-login.mjs';
import { ordinaryPracticeAsset } from '../cloud/practice-ui.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const alice = { id: '11111111-1111-4111-8111-111111111111', name: '合成用户', email: 'synthetic@example.test', admin: 0 };
const bob = { id: '22222222-2222-4222-8222-222222222222', name: '另一用户', email: 'other@example.test', admin: 0 };
const snapshot = (process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-current', import.meta.url)));

test('Hub login handoff binds browser state, uses one-time short-lived codes, checks revocation and logs out centrally', async t => {
  let active = true, now = Date.now(), logout = 0;
  const hubToken = 'a'.repeat(64);
  const auth = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/logout') { assert.equal(req.method, 'POST'); assert.equal(req.headers.origin, 'https://hub.example'); logout++; active = false; res.end('{"ok":true}'); return; }
    assert.equal(req.url, '/api/me'); res.end(JSON.stringify({ user: active && req.headers.cookie === 'qfh_session=' + hubToken ? alice : null }));
  });
  const authPort = await listen(auth), login = new HubLogin({ practiceOrigin: 'https://practice.example', hubOrigin: 'https://hub.example', authPort, now: () => now });
  const server = http.createServer(async (req, res) => {
    try { if (await login.handle(req, res, new URL(req.url, 'http://localhost'))) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await login.resolve(req))); }
    catch (error) { req.resume(); res.writeHead(error.status || 503).end('request rejected'); }
  });
  const port = await listen(server); t.after(() => Promise.all([server, auth].map(stop)));
  // Native HTTP preserves the deliberate virtual-host header. Fetch derives
  // Host from its URL and cannot simulate these two domains on one test port.
  const request = (route, host = 'practice.example', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: host, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) responseHeaders.append(name, entry);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      });
    }); req.once('error', reject); req.end();
  });
  const begin = async () => {
    const start = await request('/auth/hub'); assert.equal(start.status, 303);
    const verifier = start.headers.getSetCookie()[0].split(';')[0]; assert.match(start.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    const authorize = new URL(start.headers.get('location'));
    return { verifier, route: authorize.pathname + authorize.search };
  };
  const a = await begin();
  const signIn = await request(a.route, 'hub.example'); assert.equal(signIn.status, 303);
  const sharedLogin = new URL(signIn.headers.get('location'));
  assert.equal(sharedLogin.origin, 'https://hub.example'); assert.equal(sharedLogin.pathname, '/manage/');
  assert.equal(sharedLogin.hash, '#practice-login/' + new URL(a.route, 'https://hub.example').searchParams.get('request'));
  assert.equal(sharedLogin.href.includes(hubToken), false);
  assert.equal((await request('/practice-auth/login.js', 'hub.example')).status, 404);
  assert.equal((await request('/practice-auth/authorize?request=' + 'f'.repeat(64), 'hub.example')).status, 400);
  const granted = await request(a.route, 'hub.example', { Cookie: 'qfh_session=' + hubToken }); assert.equal(granted.status, 303);
  const callback = new URL(granted.headers.get('location')), callbackRoute = callback.pathname + callback.search;
  assert.equal(callback.href.includes(hubToken), false);
  assert.equal((await request(callbackRoute)).status, 400);
  const b = await begin(); assert.equal((await request(callbackRoute, 'practice.example', { Cookie: b.verifier })).status, 400);
  const completed = await request(callbackRoute, 'practice.example', { Cookie: a.verifier }); assert.equal(completed.status, 303); assert.equal(completed.headers.get('location'), '/');
  const session = completed.headers.getSetCookie()[0].split(';')[0]; assert.match(session, /^__Host-qfh_practice=/);
  assert.equal((await request(callbackRoute, 'practice.example', { Cookie: a.verifier })).status, 400);
  assert.deepEqual(await (await request('/me', 'practice.example', { Cookie: session })).json(), alice);
  assert.equal((await request('/auth/logout', 'practice.example', { Cookie: session, Origin: 'https://evil.example' }, 'POST')).status, 403);
  assert.equal((await request('/auth/logout', 'practice.example', { Cookie: session, Origin: 'https://practice.example' }, 'POST')).status, 200); assert.equal(logout, 1);
  assert.equal(await (await request('/me', 'practice.example', { Cookie: session })).json(), null);
  active = true;
  const expired = await begin(); const issued = await request(expired.route, 'hub.example', { Cookie: 'qfh_session=' + hubToken }); const expiredUrl = new URL(issued.headers.get('location'));
  now += 60001; assert.equal((await request(expiredUrl.pathname + expiredUrl.search, 'practice.example', { Cookie: expired.verifier })).status, 400);
  const revoked = await begin(); const revGranted = await request(revoked.route, 'hub.example', { Cookie: 'qfh_session=' + hubToken }); const revUrl = new URL(revGranted.headers.get('location'));
  const revComplete = await request(revUrl.pathname + revUrl.search, 'practice.example', { Cookie: revoked.verifier }); const revCookie = revComplete.headers.getSetCookie()[0].split(';')[0];
  active = false; assert.equal(await (await request('/me', 'practice.example', { Cookie: revCookie })).json(), null);
  active = true;
  const destination = '/cloud/import?pack=11111111-1111-4111-8111-111111111111&revision=3';
  const imported = await request('/auth/hub?return=' + encodeURIComponent(destination)); assert.equal(imported.status, 303);
  const importVerifier = imported.headers.getSetCookie()[0].split(';')[0], importAuthorize = new URL(imported.headers.get('location'));
  const importIssued = await request(importAuthorize.pathname + importAuthorize.search, 'hub.example', { Cookie: 'qfh_session=' + hubToken });
  const importCallback = new URL(importIssued.headers.get('location'));
  const importComplete = await request(importCallback.pathname + importCallback.search, 'practice.example', { Cookie: importVerifier });
  assert.equal(importComplete.headers.get('location'), destination);
  assert.equal((await request('/auth/hub?return=https://evil.example')).status, 400);
  assert.equal((await request('/auth/hub', 'evil.example')).status, 403);
});

test('ordinary cloud home creates the basic bank once per user, keeps private state and leaves daily quota available for downloads', { skip: !fs.existsSync(snapshot) }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-ordinary-'));
  const { server, cloudLibrary } = await createApp({ dataDir: directory, cloudEnabled: true, cloudRuntimeDir: snapshot, practiceHome: true, mailProvider: { ready: false },
    identityProvider: async req => req.headers.cookie === 'synthetic=alice' ? alice : req.headers.cookie === 'synthetic=bob' ? bob : null,
    cloud: { defaults: { storageBytes: 32 * 1024 ** 2, dailyTrafficBytes: 1024 ** 2, monthlyTrafficBytes: 0 } },
  });
  const port = await listen(server), origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await stop(server); await new Promise(resolve => setTimeout(resolve, 100)); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (route, user = 'alice', options = {}) => fetch(origin + route, { redirect: 'manual', ...options, headers: { Cookie: 'synthetic=' + user, ...options.headers } });
  assert.equal((await request('/', '')).headers.get('location'), '/auth/hub');
  assert.equal((await request('/api/cloud/me', '')).status, 401);
  assert.equal((await request('/api/auth/login', 'alice', { method: 'POST', headers: { Origin: origin } })).status, 403);
  const [a, aAgain, b] = await Promise.all([request('/'), request('/'), request('/', 'bob')]);
  assert.equal(a.status, 303); assert.equal(a.headers.get('location'), aAgain.headers.get('location')); assert.notEqual(a.headers.get('location'), b.headers.get('location'));
  const library = await (await request('/api/cloud/library')).json(); assert.equal(library.items.length, 1);
  const item = library.items[0], pageUrl = a.headers.get('location');
  const html = await (await request(pageUrl)).text(); assert.match(html, /用户中心/); assert.doesNotMatch(html, />网络连接<|>拓展管理<|hub-practice-nav|network-settings-form/);
  assert.match(html, /<button type="button" data-admin-contact aria-haspopup="dialog">联系管理员<\/button>/);
  assert.doesNotMatch(html, /管理账号联系方式/);
  assert.match(html, /href="\/cloud\/admin-contact.css"/);
  assert.equal((await request('/cloud/admin-contact.css')).status, 200);
  assert.equal((await request('/api/cloud/admin-contact', '')).status, 401);
  assert.deepEqual(await (await request('/api/cloud/admin-contact')).json(), { content: '', revision: 0 });
  assert.match(html, /href="\/cloud\/experience.css"/); assert.match(html, /data-src="\/cloud\/ai\?embedded=1&amp;base=%2Fcloud%2Fpractice%2F[a-f0-9-]{36}"/);
  // Web's own 用户中心 and AI 评分 markup, with the cloud storage cards; no device login dialog or page-held API Key field.
  for (const id of ['user-center-panel', 'user-center-redeem', 'ai-settings-enabled', 'ai-settings-useOfficial', 'ai-settings-points', 'cloud-storage-progress']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /hub-login-dialog|ai-settings-apiKey/);
  assert.match(html, /--qf-dim:.15;--qf-clear:.7/);
  assert.equal((await request(pageUrl, 'bob')).status, 404);
  assert.equal((await request(pageUrl, '')).headers.get('location'), '/auth/hub');
  assert.equal((await request(pageUrl + 'favicon.ico')).status, 200);
  const manifest = await (await request(pageUrl + 'manifest.webmanifest')).json(); assert.match(manifest.description, /云端/);
  for (const icon of manifest.icons) assert.equal((await request(icon.src)).status, 200);
  const adapted = await (await request(pageUrl + 'app.js')).text(); assert.match(adapted, /bindCloudExperience/); assert.doesNotMatch(adapted, /bindNetworkSettings\(|bindDevelopmentSettings\(|bindAiSettings\(/);
  const appearance = await (await request(pageUrl + 'shell/appearance.js')).text(); assert.match(appearance, /DEFAULT_DIM=15/); assert.match(appearance, /green:0,image:70/);
  const themes = await (await request(pageUrl + 'shell/themes.css')).text(); assert.match(themes, new RegExp(pageUrl + 'assets/backgrounds/dawn-lake.svg'));
  assert.equal((await request(pageUrl + 'assets/backgrounds/dawn-lake.svg')).status, 200);
  const embedded = await request('/cloud/ai?embedded=1&base=' + encodeURIComponent('/cloud/practice/' + item.id)); assert.equal(embedded.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.match(embedded.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await embedded.text(), new RegExp(`href="/cloud/practice/${item.id}/ai/ai-settings.css"`));
  assert.doesNotMatch(await (await request('/cloud/ai?embedded=1&base=' + encodeURIComponent('//evil.example'))).text(), /evil/);
  const apiBase = '/api/cloud/practice/' + item.id, question = apiBase + '/api/collections/bank/' + item.banks[0].id + '/questions/single-sample-text';
  const state = await (await request(question)).json();
  const correct = JSON.parse(fs.readFileSync(path.join(snapshot, 'basic-content/question-banks/基础题型/基础题型展示/bank.json'), 'utf8')).questions[0].data.correctOptionId;
  const submit = await request(question + '/actions', 'alice', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'ordinary-save', revision: state.state.revision, contentVersion: state.stamp.contentVersion, action: 'submit', data: { answer: { selectedOptionId: correct } } }) });
  assert.equal(submit.status, 200); assert.equal((await submit.json()).state.status, 'submitted');
  const resources = await (await request('/api/cloud/me')).json(); assert.equal(resources.usage.dailyTrafficBytes, 0); assert.equal(resources.personalMonthlyTrafficLimit, false);
  assert.equal((await (await request(question)).json()).state.status, 'submitted');
  assert.equal((await request('/')).headers.get('location'), pageUrl);
  const index = await (await request(apiBase + '/api/library/index')).json(); assert.equal(index.canManage, true);
  const manage = (input, user = 'alice') => request(apiBase + '/api/library/manage', user, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  let changed = await manage({ kind: 'bank', target: 'item', action: 'update', path: item.banks[0].path, group: item.banks[0].group || '', name: '云端重命名题库' });
  assert.equal(changed.status, 200); let catalog = (await changed.json()).catalog;
  assert.equal(catalog.banks[0].id, item.banks[0].id); assert.equal(catalog.banks[0].title, '云端重命名题库');
  const cached = (await (await request('/api/cloud/library')).json()).items[0]; assert.equal(cached.banks[0].path, catalog.banks[0].path); assert.equal(cached.title, '云端重命名题库');
  changed = await manage({ kind: 'bank', target: 'group', action: 'update', path: catalog.groups.banks[0], name: '云端基础', group: '' }); assert.equal(changed.status, 200); catalog = (await changed.json()).catalog;
  changed = await manage({ kind: 'bank', target: 'group', action: 'create', path: '', name: '我的练习', group: '' }); assert.equal(changed.status, 200); catalog = (await changed.json()).catalog;
  changed = await manage({ kind: 'bank', target: 'item', action: 'update', path: catalog.banks[0].path, name: '云端重命名题库', group: '我的练习' }); assert.equal(changed.status, 200); catalog = (await changed.json()).catalog;
  assert.equal(catalog.banks[0].id, item.banks[0].id); assert.equal(catalog.banks[0].group, '我的练习');
  const preserved = await (await request(question)).json(); assert.equal(preserved.state.status, 'submitted'); assert.equal(preserved.state.revision, 1);
  changed = await manage({ kind: 'extension', target: 'group', action: 'create', path: '', name: '空白拓展组', group: '' }); assert.equal(changed.status, 403);
  changed = await manage({ kind: 'extension', target: 'group', action: 'delete', path: index.groups.extensions[0] }); assert.equal(changed.status, 409);
  assert.equal((await manage({ kind: 'bank', target: 'item', action: 'update', path: '../extensions', name: 'unsafe', group: '' })).status, 400);
  assert.equal((await manage({ kind: 'bank', target: 'item', action: 'update', path: catalog.banks[0].path, name: 'cross-user', group: '' }, 'bob')).status, 404);
  assert.equal((await request(apiBase + '/api/settings/network')).status, 403);
  assert.equal((await (await request(apiBase + '/api/settings/development')).json()).enabled, false);
  assert.equal((await (await request('/api/cloud/me')).json()).usage.dailyTrafficBytes, 0);
  const selectedExport = await request('/api/cloud/library/' + item.id + '/export-selection', 'alice', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ bank: catalog.banks[0].path }) });
  assert.equal(selectedExport.status, 200); await selectedExport.arrayBuffer();
  assert.equal((await request('/api/cloud/library/' + item.id + '/export-selection', 'alice', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"group":"../extensions"}' })).status, 404);
  const download = await request('/api/cloud/library/' + item.id + '/export'); assert.equal(download.status, 200); await download.arrayBuffer();
  assert.ok((await (await request('/api/cloud/me')).json()).usage.dailyTrafficBytes > 0);
  const jsFile = path.join(directory, 'adapted-app.mjs'); fs.writeFileSync(jsFile, adapted); execFileSync(process.execPath, ['--check', jsFile]);
  for (const [file, content] of [['appearance.mjs', appearance], ['settings.mjs', fs.readFileSync(new URL('../public/cloud/experience.js', import.meta.url))]]) { fs.writeFileSync(path.join(directory, file), content); execFileSync(process.execPath, ['--check', path.join(directory, file)]); }
  const transfer = await (await request(pageUrl + 'library/library-transfer.js')).text(); assert.match(transfer, /downloadCloudSelection/); assert.match(transfer, /export-selection/);
  fs.writeFileSync(path.join(directory, 'transfer.mjs'), transfer); execFileSync(process.execPath, ['--check', path.join(directory, 'transfer.mjs')]);
  cloudLibrary.unifiedWorkspace = false; const legacy = await cloudLibrary.demo(alice.id); cloudLibrary.unifiedWorkspace = true;
  const oldPage = await request('/cloud/practice/' + legacy.id + '/?imported-bank=' + encodeURIComponent(legacy.banks[0].id));
  assert.equal(oldPage.status, 303); assert.equal(oldPage.headers.get('location'), pageUrl + '?imported-bank=' + encodeURIComponent(legacy.banks[0].id));
  assert.equal(cloudLibrary.list(alice.id).length, 1); assert.equal(cloudLibrary.list(alice.id)[0].banks.length, 2);
  assert.equal((await (await request(question)).json()).state.status, 'submitted');
});
