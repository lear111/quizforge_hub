import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID, createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { encryptKey, decryptKey, masterKey } from '../official-ai-config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MASTER = randomBytes(32).toString('base64');
const UPSTREAM_KEY = 'sk-synthetic-admin-key-1234';
const base = (extra = {}) => ({ enabled: false, baseUrl: 'https://upstream.example/v1', model: 'qwen-vl-plus', key: '', pricePerMillion: 30000, monthlyTokens: 10000000, ...extra });

async function fixture(t, { officialAi = base(), master = MASTER } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-admin-ai-'));
  const upstream = [];
  const officialAiFetch = async (url, init) => { upstream.push({ url, authorization: init.headers.Authorization, model: JSON.parse(init.body).model }); return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"score":1}' } }], usage: { total_tokens: 10 } }), { status: 200 }); };
  const app = await createApp({ dataDir, mailProvider: { ready: false }, adminEnabled: true, officialAi, officialAiMasterKey: master, officialAiFetch, adminCloud: async () => ({}) });
  const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  const users = {};
  for (const [name, admin] of [['root', 1], ['alice', 0]]) {
    const id = randomUUID(), cookie = randomBytes(32).toString('hex'), salt = randomBytes(16).toString('hex'), password = `pw-${name}-0123456789`;
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, `${name}@example.test`, name, `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, admin, new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(cookie), id, Date.now() + 3600000);
    users[name] = { id, password, cookie: 'qfh_session=' + cookie };
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (pathname, { method = 'GET', body, user = 'root', headers = {} } = {}) => fetch(origin + pathname, { method, headers: { ...(user ? { Cookie: users[user].cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const save = async (body, user = 'root') => { const response = await request('/api/admin/official-ai', { method: 'PUT', body, user }); return { status: response.status, body: await response.json() }; };
  return { app, db, users, request, save, upstream, dataDir };
}

test('the key is encrypted with an authenticated cipher and a wrong master key cannot read it', () => {
  const master = masterKey(MASTER), stored = encryptKey(master, UPSTREAM_KEY);
  assert.equal(decryptKey(master, stored), UPSTREAM_KEY);
  assert.equal(Buffer.from(stored, 'base64').includes(Buffer.from(UPSTREAM_KEY)), false);
  assert.throws(() => decryptKey(randomBytes(32), stored));
  const tampered = Buffer.from(stored, 'base64'); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptKey(master, tampered.toString('base64')), 'tampering is detected');
  assert.equal(masterKey('short'), null); assert.equal(masterKey(''), null);
});

test('only administrators see the settings, and a new key needs the admin password', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/official-ai', { user: 'alice' })).status, 403);
  assert.equal((await f.request('/api/admin/official-ai', { user: null })).status, 401);
  const initial = await (await f.request('/api/admin/official-ai')).json();
  assert.deepEqual({ enabled: initial.enabled, key: initial.key, encryptionReady: initial.encryptionReady, upstreamHost: initial.upstreamHost }, { enabled: false, key: { configured: false, source: null, hint: null }, encryptionReady: true, upstreamHost: 'upstream.example' });
  assert.equal((await f.save({ apiKey: UPSTREAM_KEY })).status, 403, 'no password');
  assert.equal((await f.save({ apiKey: UPSTREAM_KEY, password: 'wrong-password-0000' })).status, 403, 'wrong password');
  assert.equal((await f.save({ apiKey: UPSTREAM_KEY, password: f.users.alice.password })).status, 403, 'another user’s password');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM official_ai_config').get().n, 0, 'nothing was stored');
  const saved = await f.save({ enabled: true, apiKey: UPSTREAM_KEY, password: f.users.root.password });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.key, { configured: true, source: 'admin', hint: 'sk-…1234' });
  assert.equal(JSON.stringify(saved.body).includes(UPSTREAM_KEY), false, 'the API never returns the key');
  assert.equal((await readFile(path.join(f.dataDir, 'hub.sqlite'))).includes(Buffer.from(UPSTREAM_KEY)), false, 'the database file holds no plaintext key');
  const audit = f.db.prepare("SELECT detail FROM admin_audit WHERE action='official-ai-updated'").all().map(row => JSON.parse(row.detail).changed);
  assert.deepEqual(audit, [['enabled', 'model', 'pricePerMillion', 'monthlyTokens', 'apiKey:replaced']]);
  assert.equal(JSON.stringify(audit).includes(UPSTREAM_KEY), false);
  assert.equal((await f.save({ upstream: 'https://evil.example/v1' })).status, 400, 'the upstream address cannot be changed here');
});

test('changes apply at once: switch, price and the new key reach the gateway without a restart', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.request('/api/config', { user: null })).json()).officialAi.enabled, false);
  await f.save({ enabled: true, pricePerMillion: 500000, model: 'qwen-vl-max', apiKey: UPSTREAM_KEY, password: f.users.root.password });
  assert.equal((await (await f.request('/api/config', { user: null })).json()).officialAi.enabled, true);
  const page = await f.request('/connect/authorize?' + new URLSearchParams({ v: '1', client: 'web', redirect_uri: 'http://127.0.0.1:8787/hub/connect/callback', state: randomBytes(24).toString('base64url'), code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', device_name: 'pc' }), { user: 'alice' });
  assert.match(await page.text(), /当前剩余 ¥0\.00.*qwen-vl-max/s);
  // Give alice a device token directly to call the gateway.
  const token = 'qfd_' + randomBytes(32).toString('base64url');
  f.db.prepare('INSERT INTO connect_devices (id,user_id,token,name,client,created,last_used) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), f.users.alice.id, hash(token), 'pc', 'web', new Date().toISOString(), Date.now());
  f.db.prepare('INSERT INTO ai_points VALUES (?,?,?)').run(f.users.alice.id, 10, Date.now());
  const call = () => f.request('/api/ai/v1/chat/completions', { method: 'POST', user: null, headers: { Authorization: 'Bearer ' + token, Origin: '' }, body: { model: 'quizforge-official', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal((await call()).status, 200);
  assert.deepEqual(f.upstream.at(-1), { url: 'https://upstream.example/v1/chat/completions', authorization: 'Bearer ' + UPSTREAM_KEY, model: 'qwen-vl-max' });
  assert.equal((await call()).status, 200); assert.equal((await call()).status, 402, '10 tokens at 50 yuan per million cost 0.0005 yuan, so 0.0010 pays for two gradings');
  const status = await (await f.request('/api/admin/official-ai')).json();
  assert.deepEqual(status.usage, { todayCalls: 2, todayUsers: 1, todayCost: 10, monthTokens: 20 });
  await f.save({ enabled: false });
  assert.equal((await call()).status, 404, 'switching off stops the gateway at once');
  await f.save({ clearKey: true, password: f.users.root.password });
  assert.deepEqual((await (await f.request('/api/admin/official-ai')).json()).key, { configured: false, source: null, hint: null });
});

test('a key in the server file wins, and without a master key the backend cannot store one', async t => {
  const fromFile = await fixture(t, { officialAi: base({ key: 'sk-file-key-abcdefgh' }) });
  const status = await (await fromFile.request('/api/admin/official-ai')).json();
  assert.deepEqual(status.key, { configured: true, source: 'file', hint: 'sk-…efgh' });
  const locked = await fixture(t, { master: '' });
  assert.equal((await (await locked.request('/api/admin/official-ai')).json()).encryptionReady, false);
  const refused = await locked.save({ apiKey: UPSTREAM_KEY, password: locked.users.root.password });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'AI_ENCRYPTION_UNAVAILABLE');
  assert.equal((await locked.save({ enabled: true, pricePerMillion: 5 })).status, 200, 'other settings still work without a master key');
});

test('administrators generate redeem codes once, see them only as prefixes, and can void unused ones', async t => {
  const f = await fixture(t);
  const create = body => f.request('/api/admin/ai-codes', { method: 'POST', body });
  assert.equal((await f.request('/api/admin/ai-codes', { method: 'POST', body: { count: 1, amount: 1000, days: 1 }, user: 'alice' })).status, 403);
  assert.equal((await create({ count: 0, amount: 1000, days: 1 })).status, 400);
  const made = await create({ count: 3, amount: 1000000, days: 30, note: '首批' });
  assert.equal(made.status, 201);
  const { items } = await made.json();
  assert.equal(items.length, 3); assert.ok(items.every(item => /^AI-/.test(item.code) && item.amount === 1000000));
  const listed = await (await f.request('/api/admin/ai-codes')).json();
  assert.equal(JSON.stringify(listed).includes(items[0].code), false, 'the list never shows full codes');
  assert.deepEqual(listed.items.map(item => item.state), ['available', 'available', 'available']);
  assert.equal(listed.items[0].note, '首批');
  assert.equal((await f.request('/api/admin/ai-codes/' + items[0].id + '/revoke', { method: 'POST', body: {} })).status, 200);
  const status = await (await f.request('/api/admin/official-ai')).json();
  assert.deepEqual(status.points, { outstanding: 0, availableCodes: 2, availableCodeAmount: 2000000 });
  const audit = f.db.prepare("SELECT action,detail FROM admin_audit WHERE action LIKE 'ai-code%' ORDER BY created").all();
  assert.deepEqual(audit.map(row => row.action), ['ai-codes-created', 'ai-code-revoked']);
  assert.equal(JSON.stringify(audit).includes(items[1].code), false, 'the audit log holds no full code');
});
