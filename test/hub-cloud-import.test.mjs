import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {createPracticeApp as createApp} from '../practice/server/app.mjs';
import {javaHost} from './helpers/java-host.mjs';
import { createHubSource, hubImportTarget, importReturnPath } from '../practice/server/cloud/hub-source.mjs';

const snapshot = (process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-current', import.meta.url))), id = '11111111-1111-4111-8111-111111111111';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('cloud import target only accepts a bank and revision, with no external login redirect', () => {
  const query = `pack=${id}&revision=3`; assert.deepEqual(hubImportTarget(query), { packId: id, revision: 3 }); assert.equal(importReturnPath('/cloud/import?' + query), '/cloud/import?' + query);
  for (const input of ['https://evil.example', '//evil.example', '/cloud/import?'+query+'&next=https://evil.example', '/cloud/import?pack='+id+'&pack='+id+'&revision=3', '/cloud/import?pack='+id+'&revision=01']) assert.throws(() => importReturnPath(input));
});

test('Hub downloader rejects changed hashes, oversize manifests and redirects; it cleans temporary files and releases its slot', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfh-source-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('test-archive'), manifest = { schemaVersion: 1, pack: { id, revision: 3, title: '合成' }, archive: { name: 'test.qbank', size: bytes.length, sha256: hash(bytes) } };
  let mode = 'hash';
  const source = createHubSource({ origin: 'https://hub.example', dataDir: directory, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined); assert.equal(url.startsWith('https://hub.example/api/packs/'+id+'/'), true);
    if (mode === 'redirect') throw new Error('redirect rejected');
    if (url.includes('/local-import?')) return new Response(mode === 'oversize' ? ' '.repeat(32769) : JSON.stringify(manifest));
    return new Response(mode === 'hash' ? Buffer.from('bad!-archive') : bytes, { headers: { 'Content-Length': String(bytes.length) } });
  } });
  for (mode of ['hash', 'oversize', 'redirect']) await assert.rejects(source(id, 3));
  assert.deepEqual(await fs.readdir(path.join(directory, 'hub-downloads')), []);
  mode = 'good'; const result = await source(id, 3); assert.equal(await fs.readFile(result.file, 'utf8'), bytes.toString());
  await assert.rejects(source(id, 3), /另一份/); await result.close(); assert.deepEqual(await fs.readdir(path.join(directory, 'hub-downloads')), []);
});

test('Java Hub and the independent practice service import a format 3 bank via pinned download, preserve ownership and quota, deduplicate and reject unpublished revisions', { skip: !existsSync(snapshot)||!process.env.HUB_JAVA_JAR }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qfh-cross-hub-')), hubDir = path.join(root, 'hub'), practiceDir = path.join(root, 'practice');
  const hub=await javaHost({dataDir:hubDir,localImport:true}),hubOrigin=hub.origin;
  t.after(()=>hub.close());
  const db = new DatabaseSync(path.join(hubDir, 'hub.sqlite')), packId = randomUUID(), fileId = randomUUID(), owner = randomUUID();
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(owner, 'source@example.test', '合成作者', 'not-login', 0, new Date().toISOString());
  db.prepare("INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status,revision) VALUES(?,?,?,'test','test','','[]','1',?,?,'approved',3)").run(packId, owner, '基础示例', new Date().toISOString(), new Date().toISOString());
  const bytes = await fs.readFile(path.join(snapshot, 'basic-demo.qbank'));
  db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(fileId, packId, 'archive', 'basic.qbank', 'application/octet-stream', bytes.length, hash(bytes)); await fs.writeFile(path.join(hubDir, 'files', fileId), bytes);
  const source = createHubSource({ origin: 'https://hub.example', dataDir: practiceDir, fetchImpl: (url, options) => fetch(url.replace('https://hub.example', hubOrigin), options) });
  const alice = { id, email: 'alice@example.test', name: '合成用户', admin: 0 }, bob = { id: randomUUID(), email: 'bob@example.test', name: '另一用户', admin: 0 };
  const practice = await createApp({ dataDir: practiceDir, cloudEnabled: true, cloudRuntimeDir: snapshot, practiceHome: true, resolveCloudPack: source, mailProvider: { ready: false }, identityProvider: async req => req.headers.cookie === 'test=alice' ? alice : req.headers.cookie === 'test=bob' ? bob : null });
  await new Promise(resolve => practice.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${practice.server.address().port}`;
  t.after(async () => { await practice.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, user = 'alice', input, customOrigin = origin) => fetch(origin + route, { redirect: 'manual', ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}), headers: { Cookie: 'test='+user, Origin: customOrigin, 'Content-Type': 'application/json' } });
  const route = '/api/cloud/library/from-hub', input = { packId, revision: 3 };
  assert.equal((await request(route, '', input)).status, 401); assert.equal((await request(route, 'alice', input, 'https://evil.example')).status, 403);
  const response = await request(route, 'alice', input); assert.equal(response.status, 201, await response.clone().text()); const { item } = await response.json();
  const membership = practice.db.prepare("SELECT source FROM cloud_workspace_members WHERE json_extract(source,'$.packId')=?").get(packId);
  assert.equal(JSON.parse(membership.source).sha256, hash(bytes)); assert.equal(item.banks.length, 2);
  assert.ok(item.banks.some(bank => bank.id === item.importedBankId));
  const page = '/cloud/practice/'+item.id+'/'; assert.equal((await request(page)).status, 200); assert.equal((await request(page, 'bob')).status, 404);
  const me = await (await request('/api/cloud/me')).json(); assert.ok(me.usage.storageBytes > 0); assert.equal(me.usage.dailyTrafficBytes, 0);
  const again = await request(route, 'alice', input); assert.equal(again.status, 200); assert.equal((await again.json()).alreadyInstalled, true); assert.equal(db.prepare('SELECT downloads FROM packs WHERE id=?').get(packId).downloads, 1);
  assert.equal((await request(route, 'alice', { packId, revision: 2 })).status, 409);
  db.prepare("UPDATE packs SET status='pending' WHERE id=?").run(packId); assert.equal((await request(route, 'bob', input)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(practiceDir, 'hub-downloads')), []);
  assert.equal((await request('/cloud/import.js')).status, 200);
});
