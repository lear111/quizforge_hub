import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { localImportLink } from '../public/local-import.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
const capability = { enabled: true, protocolVersion: 1, scheme: 'quizforge' };
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-local-import-'));
  let onOpen;
  const app = await createApp({ dataDir, mailProvider: { ready: false }, localImportEnabled: true, ...options,
    localImportOpenFile: async (...args) => { const file = await open(...args); try { await onOpen?.(); return file; } catch (error) { await file.close(); throw error; } } });
  const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  const id = randomUUID(), fileId = randomUUID(), owner = randomUUID(), admin = randomUUID();
  const token = 'a'.repeat(64), adminToken = 'b'.repeat(64);
  for (const [user, name, isAdmin, raw] of [[owner, '作者', 0, token], [admin, '管理员', 1, adminToken]]) {
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(user, `${user}@example.test`, name, 'not-a-login-password', isAdmin, new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(raw), user, Date.now() + 3600000);
  }
  db.prepare(`INSERT INTO packs (id,user_id,title,summary,description,category,tags,version,created,updated,status,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, owner, '基础题型展示', 'test', 'test', '', '[]', '1990.1', '2026-10-20', '2026-10-20', 'approved', 3);
  db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(fileId, id, 'archive', '基础题型.qbank', 'application/octet-stream', bytes.length, hash(bytes));
  await writeFile(path.join(dataDir, 'files', fileId), bytes);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (route, init = {}) => fetch(origin + route, { ...init, headers: { Origin: origin, ...init.headers } });
  const downloads = () => db.prepare('SELECT downloads FROM packs WHERE id=?').get(id)?.downloads ?? 0;
  const traffic = () => db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM traffic WHERE length(period)=7').get().n;
  return { ...app, db, id, fileId, request, origin, downloads, traffic, bytes, owner, admin,
    manifest: `/api/packs/${id}/local-import?revision=3`, pinned: `/api/packs/${id}/download?revision=3&sha256=${hash(bytes)}`,
    cookies: ['', `qfh_session=${token}`, `qfh_session=${adminToken}`], onOpen: action => { onOpen = action; } };
}
async function rejected(response, status, code) {
  assert.equal(response.status, status); assert.match(response.headers.get('content-type'), /application\/json/);
  const result = await response.json(); assert.equal(result.code, `LOCAL_IMPORT_${code}`); assert.equal(typeof result.error, 'string');
}

test('local import stays disabled by default; ordinary downloads and static module remain available', async t => {
  const app = await fixture(t, { localImportEnabled: false });
  assert.deepEqual((await (await app.request('/api/config')).json()).localImport, { ...capability, enabled: false });
  await rejected(await app.request(app.manifest), 404, 'DISABLED');
  await rejected(await app.request(app.pinned), 404, 'DISABLED');
  assert.equal(app.downloads(), 0); assert.equal(app.traffic(), 0);
  assert.deepEqual(Buffer.from(await (await app.request(`/api/packs/${app.id}/download`)).arrayBuffer()), bytes);
  assert.equal(app.downloads(), 1); assert.equal(app.traffic(), bytes.length);
  const script = await app.request('/local-import.js'); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
});

test('public v1 manifest and fixed version deliver exact bytes without metadata accounting', async t => {
  const app = await fixture(t);
  assert.deepEqual((await (await app.request('/api/config')).json()).localImport, capability);
  for (let n = 0; n < 2; n++) {
    const response = await app.request(app.manifest);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { schemaVersion: 1, pack: { id: app.id, revision: 3, title: '基础题型展示' },
      archive: { name: '基础题型.qbank', size: bytes.length, sha256: hash(bytes) } });
  }
  assert.equal(app.downloads(), 0); assert.equal(app.traffic(), 0);
  const response = await app.request(app.pinned); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(app.downloads(), 1); assert.equal(app.traffic(), bytes.length);
});

test('unpublished and removed packs cannot be imported even by their author or an administrator', async t => {
  const app = await fixture(t);
  for (const status of ['pending', 'rejected']) {
    app.db.prepare('UPDATE packs SET status=?,revision=4 WHERE id=?').run(status, app.id);
    for (const cookie of app.cookies) for (const route of [app.manifest, app.pinned]) {
      await rejected(await app.request(route, { headers: { Cookie: cookie } }), 404, 'UNAVAILABLE');
    }
  }
  app.db.prepare('DELETE FROM packs WHERE id=?').run(app.id);
  await rejected(await app.request(app.manifest), 404, 'UNAVAILABLE');
  await rejected(await app.request(app.pinned), 404, 'UNAVAILABLE'); assert.equal(app.traffic(), 0);
});

test('fixed version requests reject changed revision/hash and malformed or partial parameters', async t => {
  const app = await fixture(t), prefix = `/api/packs/${app.id}`;
  for (const query of ['', '?revision=03', '?revision=0', '?revision=9007199254740992', '?revision=3&revision=3', '?revision=3&x=1', '?revision=%33']) {
    await rejected(await app.request(prefix + '/local-import' + query), 400, 'REQUEST_INVALID');
  }
  for (const query of ['?revision=3', '?sha256=' + hash(bytes), '?revision=3&sha256=no', '?revision=3&sha256=' + hash(bytes) + '&x=1', '?revision=3&revision=3&sha256=' + hash(bytes)]) {
    await rejected(await app.request(prefix + '/download' + query), 400, 'REQUEST_INVALID');
  }
  await rejected(await app.request(app.manifest, { method: 'POST' }), 405, 'REQUEST_INVALID');
  await rejected(await app.request(app.pinned.replace(hash(bytes), 'f'.repeat(64))), 409, 'REVISION_CHANGED');
  app.db.prepare('UPDATE packs SET revision=4 WHERE id=?').run(app.id);
  await rejected(await app.request(app.manifest), 409, 'REVISION_CHANGED');
  await rejected(await app.request(app.pinned), 409, 'REVISION_CHANGED');
  assert.equal(app.downloads(), 0); assert.equal(app.traffic(), 0);
});

test('unsupported archives, oversized or missing files fail before reserving traffic', async t => {
  const app = await fixture(t);
  for (const name of ['old.zip', 'old.rar', 'old.7z']) {
    app.db.prepare('UPDATE files SET name=? WHERE id=?').run(name, app.fileId);
    await rejected(await app.request(app.manifest), 422, 'FORMAT_UNSUPPORTED');
    await rejected(await app.request(app.pinned), 422, 'FORMAT_UNSUPPORTED');
  }
  app.db.prepare('UPDATE files SET name=?,size=? WHERE id=?').run('example.QBANK', 67108865, app.fileId);
  await rejected(await app.request(app.manifest), 413, 'TOO_LARGE');
  await rejected(await app.request(app.pinned), 413, 'TOO_LARGE');
  app.db.prepare('UPDATE files SET size=? WHERE id=?').run(bytes.length, app.fileId);
  await writeFile(path.join(app.dataDir, 'files', app.fileId), bytes.subarray(0, 2));
  await rejected(await app.request(app.pinned), 404, 'UNAVAILABLE');
  await rm(path.join(app.dataDir, 'files', app.fileId));
  await rejected(await app.request(app.manifest), 404, 'UNAVAILABLE');
  assert.equal(app.downloads(), 0); assert.equal(app.traffic(), 0);
});

test('open/stat races recheck publication, revision and file identity before manifest or debit', async t => {
  const app = await fixture(t);
  for (const route of [app.manifest, app.pinned]) {
    for (const mutation of ['revision', 'status', 'file']) {
      app.db.prepare('UPDATE packs SET status=\'approved\',revision=3 WHERE id=?').run(app.id);
      app.db.prepare('UPDATE files SET id=? WHERE pack_id=?').run(app.fileId, app.id);
      app.onOpen(() => {
        if (mutation === 'revision') app.db.prepare('UPDATE packs SET revision=4 WHERE id=?').run(app.id);
        else if (mutation === 'status') app.db.prepare('UPDATE packs SET status=\'pending\' WHERE id=?').run(app.id);
        else app.db.prepare('UPDATE files SET id=? WHERE pack_id=?').run(randomUUID(), app.id);
      });
      await rejected(await app.request(route), mutation === 'status' ? 404 : 409, mutation === 'status' ? 'UNAVAILABLE' : 'REVISION_CHANGED');
    }
  }
  assert.equal(app.downloads(), 0); assert.equal(app.traffic(), 0);
});

test('fixed delivery streams the opened file rather than reopening a replaced pathname', async t => {
  const app = await fixture(t); const file = path.join(app.dataDir, 'files', app.fileId);
  app.onOpen(async () => { await rename(file, file + '.original'); await writeFile(file, Buffer.alloc(bytes.length, 65)); });
  const response = await app.request(app.pinned); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('traffic budget and independent manifest/download throttles have stable errors', async t => {
  const app = await fixture(t, { monthlyBudgetBytes: bytes.length });
  assert.equal((await app.request(app.pinned)).status, 200);
  await rejected(await app.request(app.pinned), 429, 'TRAFFIC_LIMIT');
  for (let n = 0; n < 60; n++) assert.equal((await app.request(app.manifest)).status, 200);
  await rejected(await app.request(app.manifest), 429, 'RATE_LIMITED');
  for (let n = 2; n < 30; n++) await rejected(await app.request(app.pinned), 429, 'TRAFFIC_LIMIT');
  await rejected(await app.request(app.pinned), 429, 'RATE_LIMITED');
  assert.equal(app.downloads(), 1); assert.equal(app.traffic(), bytes.length);
});

test('local links require public qbank and v1 capability; year/content version are irrelevant', () => {
  const pack = { id: randomUUID(), status: 'approved', revision: 3, version: '1990.1', archive: { name: 'example.qbank' } };
  assert.equal(localImportLink(pack, capability), `quizforge://hub/import?v=1&pack=${pack.id}&revision=3`);
  for (const config of [undefined, { ...capability, enabled: false }, { ...capability, protocolVersion: 2 }, { ...capability, scheme: 'evil' }]) assert.equal(localImportLink(pack, config), null);
  for (const value of [{ ...pack, status: 'pending' }, { ...pack, id: 'javascript:alert(1)' }, { ...pack, revision: 0 }, { ...pack, archive: { name: 'old.zip' } }]) assert.equal(localImportLink(value, capability), null);
});
