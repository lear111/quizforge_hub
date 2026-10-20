import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createPracticeAdminBridge, createAdminClient } from '../admin/bridge.mjs';
import { loadRuntime } from '../cloud/runtime.mjs';

const snapshot = fileURLToPath(new URL('../.runtime/web-current', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qfh-admin-')), hubDir = path.join(root, 'hub'), practiceDir = path.join(root, 'practice');
  let client;
  const hub = await createApp({ dataDir: hubDir, adminEnabled: true, mailProvider: { ready: false }, adminCloud: (...args) => client(...args) });
  const hubPort = await listen(hub.server), hubOrigin = 'http://127.0.0.1:' + hubPort;
  const tokens = { admin: 'a'.repeat(64), user: 'b'.repeat(64), newcomer: 'c'.repeat(64) }, people = {};
  for (const [name, token] of Object.entries(tokens)) {
    const user = { id: randomUUID(), email: name + '@example.test', name, admin: name === 'admin' ? 1 : 0 }; people[name] = user;
    hub.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(user.id, user.email, user.name, 'synthetic-not-login', user.admin, new Date().toISOString());
    hub.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, Date.now() + 3600000);
  }
  const identity = async token => (await (await fetch(hubOrigin + '/api/me', { headers: { Cookie: 'qfh_session=' + token } })).json()).user;
  const practice = await createApp({ dataDir: practiceDir, cloudEnabled: true, cloudRuntimeDir: snapshot, mailProvider: { ready: false }, identityProvider: req => identity((req.headers.cookie || '').replace('qfh_session=', '')) });
  const practicePort = await listen(practice.server), practiceOrigin = 'http://127.0.0.1:' + practicePort;
  const bridge = createPracticeAdminBridge({ library: practice.cloudLibrary, reviews: practice.reviewPackages, authenticate: identity, hubPort, onAdminError: error => console.error('Synthetic bridge error:', error) });
  const bridgePort = await listen(bridge.server); client = createAdminClient({ port: bridgePort });
  t.after(async () => { await stop(bridge.server); await Promise.all([stop(practice.server), stop(hub.server)]); await new Promise(resolve => setTimeout(resolve, 100)); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, body, user = 'admin', method = body ? 'POST' : 'GET', origin = hubOrigin) => fetch(hubOrigin + route, { method, redirect: 'manual', headers: { Cookie: user ? 'qfh_session=' + tokens[user] : '', Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const upload = (route, bytes, name = 'synthetic.qbank', user = 'admin') => fetch(hubOrigin + route, { method: 'POST', headers: { Cookie: 'qfh_session=' + tokens[user], Origin: hubOrigin, 'Content-Type': 'application/octet-stream', 'X-QuizForge-Filename': encodeURIComponent(name) }, body: bytes });
  return { root, hubDir, practiceDir, hub, practice, bridge, hubOrigin, hubPort, practiceOrigin, bridgePort, tokens, people, request, upload };
}
async function customPackage(root, { dangerous = false } = {}) {
  const runtime = await loadRuntime(snapshot), directory = path.join(root, randomUUID()); await fs.mkdir(directory);
  const archive = new runtime.LibraryArchive(directory, new runtime.ResourceStore(directory));
  await archive.unzip(path.join(snapshot, 'basic-demo.qbank'), directory);
  for (const extension of runtime.scanExtensions(path.join(directory, 'extensions'))) {
    const file = path.join(extension, 'manifest.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8')); manifest.id = 'admin-test.' + manifest.id; await fs.writeFile(file, JSON.stringify(manifest));
    if (dangerous) await fs.writeFile(path.join(extension, manifest.rules), 'throw new Error("PENDING_REVIEW_CODE_MUST_NOT_EXECUTE");');
  }
  const content = path.join(root, randomUUID()); await fs.mkdir(content);
  for (const name of ['question-banks', 'extensions', 'quizforge-package.json']) await fs.cp(path.join(directory, name), path.join(content, name), { recursive: true });
  const file = path.join(root, randomUUID() + '.qbank'); await archive.zip(content, file); return fs.readFile(file);
}

test('admin endpoints require the real Hub administrator, CSRF checks and private loopback bridge; invitations, quotas and blocks persist', { skip: !existsSync(snapshot) }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/overview', null, '')).status, 401);
  assert.equal((await f.request('/api/admin/overview', null, 'user')).status, 403);
  assert.equal((await f.request('/admin/', null, 'user')).status, 403); assert.equal((await f.request('/admin/')).status, 200);
  assert.equal((await f.request('/api/admin/invitations', { count: 1, days: 7 }, 'admin', 'POST', 'https://evil.example')).status, 403);
  const created = await f.request('/api/admin/invitations', { count: 2, days: 7 }); assert.equal(created.status, 201); const { items } = await created.json();
  const listed = await (await f.request('/api/admin/invitations')).json(); assert.equal(JSON.stringify(listed).includes(items[0].code), false);
  assert.equal((await f.request('/api/admin/invitations/' + items[0].id + '/revoke', {})).status, 200);
  const privateForbidden = await fetch(`http://127.0.0.1:${f.bridgePort}/internal/admin/summary`, { headers: { Cookie: 'qfh_session=' + f.tokens.user } }); assert.equal(privateForbidden.status, 403);
  const users = await (await f.request('/api/admin/users')).json(); assert.equal(users.users.length, 3); assert.equal(JSON.stringify(users).includes('password'), false);
  assert.equal((await f.request('/api/admin/cloud/users/' + f.people.newcomer.id + '/limits', { storageBytes: 32 * 1024 ** 2, dailyTrafficBytes: 1024, reason: '测试新用户额度' }, 'admin', 'PUT')).status, 200);
  assert.equal((await (await f.request('/api/admin/users')).json()).users.find(u => u.id === f.people.newcomer.id).resources.limits.dailyTrafficBytes, 1024);
  const block = '/api/admin/users/' + f.people.user.id + '/block';
  assert.equal((await f.request(block, { blocked: true, reason: '测试封禁同步' }, 'admin', 'PUT')).status, 200);
  assert.equal((await (await f.request('/api/me', null, 'user')).json()).user, null);
  assert.equal((await fetch(f.practiceOrigin + '/api/cloud/me', { headers: { Cookie: 'qfh_session=' + f.tokens.user } })).status, 401);
  assert.equal((await f.request('/api/admin/users/' + f.people.admin.id + '/block', { blocked: true, reason: '不能封禁自己' }, 'admin', 'PUT')).status, 400);
});

test('pre-review never executes unknown rules, exposes code only as JSON text, and checks server-computed immutable hashes', { skip: !existsSync(snapshot) }, async t => {
  const f = await fixture(t), buffer = await customPackage(f.root, { dangerous: true });
  const response = await f.upload('/api/admin/cloud/submissions', buffer); assert.equal(response.status, 200, await response.clone().text()); const { item } = await response.json();
  assert.equal(item.status, 'pending'); assert.ok(item.extensions.every(e => e.status === 'unknown'));
  const first = item.extensions[0], file = await (await f.request('/api/admin/cloud/submissions/' + item.id + '/file?' + new URLSearchParams({ extension: first.digest, path: 'rules.js' }))).json();
  assert.match(file.text, /PENDING_REVIEW_CODE_MUST_NOT_EXECUTE/);
  const privateSubmission = await fetch(f.practiceOrigin + '/api/cloud/extensions/submissions', { method: 'POST', headers: { Cookie: 'qfh_session=' + f.tokens.user, Origin: f.practiceOrigin, 'X-QuizForge-Filename': 'private.qbank' }, body: buffer });
  assert.equal(privateSubmission.status, 201, await privateSubmission.clone().text());
  const privateJob = (await privateSubmission.json()).item;
  const own = await (await fetch(f.practiceOrigin + '/api/cloud/extensions/submissions', { headers: { Cookie: 'qfh_session=' + f.tokens.user } })).json(); assert.deepEqual(own.items.map(x => x.id), [privateJob.id]);
  const other = await (await fetch(f.practiceOrigin + '/api/cloud/extensions/submissions', { headers: { Cookie: 'qfh_session=' + f.tokens.newcomer } })).json(); assert.equal(other.items.length, 0);
  assert.equal((await f.request('/api/admin/cloud/submissions/' + item.id + '/file?' + new URLSearchParams({ extension: first.digest, path: '../bank.json' }))).status, 404);
  assert.equal((await f.request('/api/admin/cloud/submissions/' + item.id + '/decision', { decision: 'approved', reason: '缺少确认', codeReviewed: false })).status, 400);
  await fs.appendFile(path.join(f.practiceDir, 'extension-submissions', item.id, 'extensions', String(first.index), 'rules.js'), '\n// changed after review');
  assert.equal((await f.request('/api/admin/cloud/submissions/' + item.id + '/decision', { decision: 'approved', reason: '文件变化应拦截', codeReviewed: true })).status, 409);
  assert.ok((await (await f.request('/api/admin/cloud/extensions')).json()).entries.every(e => e.digest !== first.digest));
  assert.equal(await fs.stat(path.join(f.practiceDir, 'extension-submissions', item.id, 'question-banks')).then(() => true, () => false), false);
  assert.equal((await f.request('/api/admin/cloud/submissions/' + item.id + '/decision', { decision: 'rejected', reason: '损坏的快照仍可驳回' })).status, 200);
  const runtime = await loadRuntime(snapshot), unpacked = path.join(f.root, 'standalone-source'); await fs.mkdir(unpacked);
  const archive = new runtime.LibraryArchive(unpacked, new runtime.ResourceStore(unpacked)); await archive.unzip(path.join(snapshot, 'basic-demo.qbank'), unpacked);
  const directory = runtime.scanExtensions(path.join(unpacked, 'extensions'))[0], note = 'review file with spaces\n'.repeat(30000);
  await fs.writeFile(path.join(directory, 'audit note.txt'), note);
  const zip = path.join(f.root, 'standalone.zip'); await archive.zip(directory, zip);
  const standalone = await f.upload('/api/admin/cloud/submissions', await fs.readFile(zip), 'standalone.zip'); assert.equal(standalone.status, 200, await standalone.clone().text());
  const standJob = (await standalone.json()).item; assert.equal(standJob.extensions.length, 1); assert.equal(standJob.status, 'pending');
  const download = await f.request('/api/admin/cloud/submissions/' + standJob.id + '/file?' + new URLSearchParams({ extension: standJob.extensions[0].digest, path: 'audit note.txt', download: '1' }));
  assert.equal(download.status, 200); const raw = await download.json(); assert.equal(raw.truncated, true); assert.equal(Buffer.from(raw.base64, 'base64').toString(), note);
});

test('one public-package review registers extension hashes, private imports reuse them, delivery uses recipient quota and revocation blocks later imports', { skip: !existsSync(snapshot) }, async t => {
  const f = await fixture(t), buffer = await customPackage(f.root), id = randomUUID(), fileId = randomUUID(), created = new Date().toISOString();
  f.hub.db.prepare("INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status,revision) VALUES(?,?,?,'summary','description','','[]','1',?,?,'pending',1)").run(id, f.people.user.id, '合成公共题库', created, created);
  f.hub.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(fileId, id, 'archive', 'synthetic.qbank', 'application/octet-stream', buffer.length, hash(buffer)); await fs.writeFile(path.join(f.hubDir, 'files', fileId), buffer);
  assert.equal((await f.upload('/api/admin/cloud/users/' + f.people.newcomer.id + '/import', buffer)).status, 422);
  const inspection = await f.request('/api/admin/packs/' + id + '/inspect', {}); assert.equal(inspection.status, 200, await inspection.clone().text()); const job = (await inspection.json()).item;
  const approved = await f.request('/api/admin/packs/' + id + '/decision', { revision: 1, decision: 'approved', codeReviewed: true, reason: '合成整包及代码审核' }); assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal(f.hub.db.prepare('SELECT status FROM packs WHERE id=?').get(id).status, 'approved');
  const white = (await (await f.request('/api/admin/cloud/extensions')).json()).entries; for (const e of job.extensions) assert.equal(white.find(x => x.digest === e.digest)?.status, 'approved');
  const known = await f.upload('/api/admin/cloud/submissions', buffer); assert.equal((await known.json()).item.status, 'verified');
  await f.request('/api/admin/cloud/users/' + f.people.newcomer.id + '/limits', { storageBytes: 0, dailyTrafficBytes: null, reason: '验证交付不能绕过接收用户额度' }, 'admin', 'PUT');
  assert.equal((await f.upload('/api/admin/cloud/users/' + f.people.newcomer.id + '/import', buffer)).status, 413);
  assert.equal(f.practice.db.prepare('SELECT COUNT(*) AS n FROM cloud_imports').get().n, 0);
  await f.request('/api/admin/cloud/users/' + f.people.newcomer.id + '/limits', { storageBytes: null, dailyTrafficBytes: null, reason: '恢复默认额度继续交付验证' }, 'admin', 'PUT');
  const delivered = await f.upload('/api/admin/cloud/users/' + f.people.newcomer.id + '/import', buffer); assert.equal(delivered.status, 200, await delivered.clone().text()); const item = (await delivered.json()).item;
  assert.equal(item.source.kind, 'admin-delivery');
  const targetAccount = f.practice.cloudAccounts.status(f.people.newcomer.id); assert.ok(targetAccount.usage.storageBytes > 0); assert.equal(f.practice.cloudAccounts.status(f.people.admin.id).usage.storageBytes, 0);
  const owner = await fetch(f.practiceOrigin + '/cloud/practice/' + item.id + '/', { headers: { Cookie: 'qfh_session=' + f.tokens.newcomer } }); assert.equal(owner.status, 200);
  const stranger = await fetch(f.practiceOrigin + '/cloud/practice/' + item.id + '/', { headers: { Cookie: 'qfh_session=' + f.tokens.user } }); assert.equal(stranger.status, 404);
  const audit = await (await f.request('/api/admin/audit')).json(); assert.ok(audit.items.some(x => x.action === 'private-delivery')); assert.ok(audit.items.some(x => x.action === 'pack-approved'));
  const revoked = await f.request('/api/admin/cloud/extensions/revoke', { digest: job.extensions[0].digest, reason: '合成撤销检查' }); assert.equal(revoked.status, 200);
  assert.equal((await f.upload('/api/admin/cloud/users/' + f.people.newcomer.id + '/import', buffer)).status, 422);
  assert.equal(f.practice.db.prepare("SELECT COUNT(*) AS n FROM cloud_imports WHERE status='ready'").get().n, 1);
  assert.equal(f.hub.db.prepare('SELECT status FROM pack_cloud_approvals WHERE pack_id=?').get(id).status, 'revoked');
  const affected = await (await f.request('/api/admin/cloud/extensions/affected?digest=' + job.extensions[0].digest)).json();
  assert.deepEqual(affected.items.map(row => row.id), [item.id]); assert.equal(affected.publicPacks[0].id, id);
  const stopped = await fetch(f.practiceOrigin + '/api/cloud/practice/' + item.id + '/api/library/index', { headers: { Cookie: 'qfh_session=' + f.tokens.newcomer } }); assert.equal(stopped.status, 422);
});

test('real user activity deduplicates accounts and keeps heartbeat out of DAU; public/private content never appears in metric records', { skip: !existsSync(snapshot) }, async t => {
  const f = await fixture(t);
  await f.request('/api/activity', { kind: 'heartbeat' }, 'user'); let result = await (await f.request('/api/admin/overview')).json(); assert.equal(result.online, 1); assert.equal(result.today.active, 0);
  await f.request('/api/activity', { kind: 'visit' }, 'user'); await f.request('/api/activity', { kind: 'visit' }, 'user'); await f.request('/api/activity', { kind: 'practice' }, 'user');
  result = await (await f.request('/api/admin/overview?days=30')).json(); assert.equal(result.today.active, 1); assert.equal(result.today.practice, 1); assert.equal(result.trend.length, 30); assert.equal(result.total, 3);
  f.hub.metrics.transfer(99); f.practice.metrics.transfer(101);
  result = await (await f.request('/api/admin/overview')).json(); assert.equal(result.transfers.bytes, 200); assert.equal(result.transfers.requests, 2);
  assert.equal((await f.request('/api/activity', { kind: 'arbitrary-event' }, 'user')).status, 400);
  const page = await (await f.request('/admin/')).text(); assert.match(page, /\/admin\/app.js/); assert.doesNotMatch(page, /演示数据|DEMO-NOT-VALID/);
});
