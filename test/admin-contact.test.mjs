import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { createAdminContactSource } from '../cloud/admin-contact.mjs';

const stop = app => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qfh-contact-'));
  let app, origin;
  const start = async () => {
    app = await createApp({ dataDir: directory, adminEnabled: true, mailProvider: { ready: false }, smsProvider: { ready: false } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + app.server.address().port;
  };
  await start();
  for (const [role, admin, token] of [['admin', 1, 'a'.repeat(64)], ['ordinary', 0, 'b'.repeat(64)]]) {
    const id = randomUUID();
    app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, role + '@example.test', '合成账号', 'unused-synthetic-hash', admin, new Date().toISOString());
    app.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 3600000);
  }
  const request = (route, { actor, content, revision, method = content === undefined ? 'GET' : 'PUT', body, foreign = false } = {}) => fetch(origin + route, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: foreign ? 'https://untrusted.example' : origin,
      ...(actor ? { Cookie: 'qfh_session=' + (actor === 'admin' ? 'a' : 'b').repeat(64) } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify(body || { content, revision }) } : {}),
  });
  t.after(async () => { await stop(app); await rm(directory, { recursive: true, force: true }); });
  return { request, get app() { return app; }, get port() { return app.server.address().port; }, restart: async () => { await stop(app); await start(); } };
}

test('contact editing is administrator-only, validates revisions, persists and publishes only explicit content', async t => {
  const f = await fixture(t), route = '/api/admin/contact';
  const empty = await f.request('/api/admin-contact');
  assert.equal(empty.status, 200); assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await empty.json(), { content: '', revision: 0 });
  assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request(route, { actor: 'ordinary' })).status, 403);
  const content = '  QuizForge 联系方式\r\n邮箱：support@example.test\r\n<svg onload="alert(1)">不会执行</svg>  ';
  assert.equal((await f.request(route, { actor: 'ordinary', content, revision: 0 })).status, 403);
  assert.equal((await f.request(route, { actor: 'admin', content, revision: 0, foreign: true })).status, 403);
  assert.equal((await f.request(route, { actor: 'admin', content: 'x'.repeat(4001), revision: 0 })).status, 400);
  assert.equal((await f.request(route, { actor: 'admin', body: { content: 'x', revision: 0, url: 'https://untrusted.example' }, method: 'PUT' })).status, 400);
  const saved = await f.request(route, { actor: 'admin', content, revision: 0 }); assert.equal(saved.status, 200);
  const value = await saved.json(); assert.equal(value.revision, 1); assert.equal(value.content, content.trim().replaceAll('\r\n', '\n'));
  assert.equal((await f.request(route, { actor: 'admin', content: 'stale overwrite', revision: 0 })).status, 409);
  await f.restart(); assert.deepEqual(await (await f.request('/api/admin-contact')).json(), value);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='admin-contact-updated'").get().n, 1);
  const home = await (await f.request('/')).text();
  assert.match(home, /class="qfh-contact-float" data-admin-contact/); assert.doesNotMatch(home, /support@example.test|onload="alert/);
  for (const file of ['/admin-contact.js', '/admin-contact.css']) assert.equal((await f.request(file)).status, 200);
  assert.equal((await f.request(route, { actor: 'admin', content: '', revision: 1 })).status, 200);
  assert.deepEqual(await (await f.request('/api/admin-contact')).json(), { content: '', revision: 2 });
});

test('failed audit rolls back the contact content and revision together', async t => {
  const f = await fixture(t);
  f.app.db.exec("CREATE TRIGGER fail_contact_audit BEFORE INSERT ON admin_audit WHEN NEW.action='admin-contact-updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.request('/api/admin/contact', { actor: 'admin', content: 'must roll back', revision: 0 })).status, 500);
  assert.deepEqual(await (await f.request('/api/admin-contact')).json(), { content: '', revision: 0 });
});

test('practice reads the same Hub setting on every request and keeps its personal endpoint authenticated', async t => {
  const hub = await fixture(t), directory = await mkdtemp(path.join(os.tmpdir(), 'qfh-contact-practice-'));
  const source = createAdminContactSource({ port: hub.port });
  const practice = await createApp({ dataDir: directory, cloudEnabled: true, mailProvider: { ready: false }, smsProvider: { ready: false }, adminContactSource: source,
    identityProvider: async req => req.headers.cookie === 'synthetic=account' ? { id: '11111111-1111-4111-8111-111111111111', name: '合成账号', email: 'user@example.test', admin: 0 } : null });
  await new Promise(resolve => practice.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await stop(practice); await rm(directory, { recursive: true, force: true }); });
  const endpoint = 'http://127.0.0.1:' + practice.server.address().port + '/api/cloud/admin-contact';
  assert.equal((await fetch(endpoint)).status, 401);
  const read = async () => (await fetch(endpoint, { headers: { Cookie: 'synthetic=account' } })).json();
  assert.equal((await read()).content, '');
  await hub.request('/api/admin/contact', { actor: 'admin', content: '第一版联系方式', revision: 0 });
  assert.equal((await read()).content, '第一版联系方式');
  await hub.request('/api/admin/contact', { actor: 'admin', content: '更新后的联系方式\n第二行', revision: 1 });
  assert.equal((await read()).content, '更新后的联系方式\n第二行');
});

test('the internal contact reader uses a fixed anonymous endpoint and rejects redirects, oversize or malformed data', async () => {
  let seen;
  const read = createAdminContactSource({ fetcher: async (url, options) => { seen = { url, options }; return new Response(JSON.stringify({ content: 'ok', revision: 1, private: 'not returned' })); } });
  assert.deepEqual(await read(), { content: 'ok', revision: 1 });
  assert.equal(seen.url, 'http://127.0.0.1:4318/api/admin-contact'); assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.headers, undefined);
  for (const result of [new Response('', { status: 302 }), new Response('x'.repeat(32769)), new Response('{broken'), new Response('{"content":1,"revision":0}')]) {
    await assert.rejects(createAdminContactSource({ fetcher: async () => result })(), { status: 503 });
  }
});
