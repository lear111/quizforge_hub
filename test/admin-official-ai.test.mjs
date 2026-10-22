import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID, createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { encryptKey, decryptKey, masterKey, upstreamFailure } from '../official-ai-config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MASTER = randomBytes(32).toString('base64');
const defaults = { baseUrl: 'https://upstream.example/v1', model: 'qwen-vl-plus', inputPrice: 30000, outputPrice: 90000 };
const keyInput = (extra = {}) => ({ note: '主账号', baseUrl: 'https://one.example/v1', model: 'qwen-vl-plus', apiKey: 'sk-synthetic-one-1234', inputPrice: 10000, outputPrice: 20000, ...extra });

// The fake upstream answers per address; `replies` maps a host to a function returning a Response.
async function fixture(t, { master = MASTER, before } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-admin-ai-'));
  const upstream = [], replies = {};
  const ok = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"score":1}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200 });
  const officialAiFetch = async (url, init) => { const host = new URL(url).host; upstream.push({ host, authorization: init.headers.Authorization, model: JSON.parse(init.body).model }); return (replies[host] || ok)(); };
  if (before) { const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite')); before(db); db.close(); }
  const app = await createApp({ dataDir, mailProvider: { ready: false }, adminEnabled: true, officialAi: defaults, officialAiMasterKey: master, officialAiFetch, adminCloud: async () => ({}) });
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
  const request = async (pathname, { method = 'GET', body, user = 'root', headers = {} } = {}) => {
    const response = await fetch(origin + pathname, { method, headers: { ...(user ? { Cookie: users[user].cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const addKey = (extra, user = 'root') => request('/api/admin/ai-keys', { method: 'POST', user, body: { ...keyInput(extra), password: users[user].password } });
  const keys = async () => (await request('/api/admin/official-ai')).body.keys;
  // A device token for alice and a grading call through the gateway.
  const token = 'qfd_' + randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO connect_devices (id,user_id,token,name,client,created,last_used) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), users.alice.id, hash(token), 'pc', 'web', new Date().toISOString(), Date.now());
  const grant = amount => db.prepare('INSERT INTO ai_points VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance').run(users.alice.id, amount, Date.now());
  const grade = () => request('/api/ai/v1/chat/completions', { method: 'POST', user: null, headers: { Authorization: 'Bearer ' + token, Origin: '' }, body: { model: 'quizforge-official', messages: [{ role: 'user', content: 'x' }] } });
  return { app, db, users, request, addKey, keys, grant, grade, upstream, replies, dataDir };
}

test('keys and codes are encrypted with an authenticated cipher, and provider errors map to statuses', () => {
  const master = masterKey(MASTER), stored = encryptKey(master, 'sk-synthetic-admin-key-1234');
  assert.equal(decryptKey(master, stored), 'sk-synthetic-admin-key-1234');
  assert.throws(() => decryptKey(randomBytes(32), stored));
  const tampered = Buffer.from(stored, 'base64'); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptKey(master, tampered.toString('base64')), 'tampering is detected');
  assert.equal(masterKey('short'), null);
  assert.equal(upstreamFailure(400, '{"code":"Arrearage"}').status, 'insufficient');
  assert.equal(upstreamFailure(402, '').status, 'insufficient');
  assert.equal(upstreamFailure(429, '{"error":{"code":"insufficient_quota"}}').status, 'throttled', 'a rate limit is brief, not a fault or arrears');
  assert.equal(upstreamFailure(401, '{"code":"InvalidApiKey"}').status, 'fault');
  assert.equal(upstreamFailure(400, '{"code":"InvalidParameter"}').status, 'rejected');
});

test('only administrators manage keys; adding needs the password and saves the test result as the first status', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/official-ai', { user: 'alice' })).status, 403);
  assert.equal((await f.request('/api/admin/official-ai', { user: null })).status, 401);
  assert.equal((await f.request('/api/admin/ai-keys', { method: 'POST', body: { ...keyInput(), password: 'wrong-password-0000' } })).status, 403);
  assert.equal((await f.request('/api/admin/ai-keys', { method: 'POST', body: keyInput() })).status, 403, 'no password');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_upstreams').get().n, 0, 'nothing was stored');
  assert.equal((await f.addKey({ baseUrl: 'http://plain.example/v1' })).status, 400, 'only HTTPS addresses');
  const added = await f.addKey();
  assert.equal(added.status, 201); assert.equal(added.body.test.ok, true);
  assert.deepEqual({ seq: added.body.item.seq, state: added.body.item.state, keyHint: added.body.item.keyHint, host: added.body.item.host }, { seq: 1, state: 'ok', keyHint: 'sk-…1234', host: 'one.example' });
  assert.equal(JSON.stringify(added.body).includes('sk-synthetic-one-1234'), false, 'the API never returns the key');
  assert.equal((await readFile(path.join(f.dataDir, 'hub.sqlite'))).includes(Buffer.from('sk-synthetic-one-1234')), false, 'no plaintext key in the database');
  f.replies['two.example'] = () => new Response('{"code":"Arrearage"}', { status: 400 });
  f.replies['three.example'] = () => new Response('', { status: 503 });
  const arrears = await f.addKey({ baseUrl: 'https://two.example/v1', apiKey: 'sk-synthetic-two-5678' });
  const broken = await f.addKey({ baseUrl: 'https://three.example/v1', apiKey: 'sk-synthetic-three-9012' });
  assert.equal(arrears.status, 201, 'a key that fails its test is still saved');
  assert.deepEqual([arrears.body.item.state, broken.body.item.state], ['insufficient', 'fault']);
  assert.match(broken.body.item.reason, /HTTP 503/);
  const audit = f.db.prepare("SELECT detail FROM admin_audit WHERE action='ai-key-added'").all();
  assert.equal(audit.length, 3); assert.equal(JSON.stringify(audit).includes('sk-synthetic'), false, 'the audit log holds no key');
  assert.equal((await f.request(`/api/admin/ai-keys/${added.body.item.id}`, { method: 'PUT', body: { baseUrl: 'https://evil.example/v1' } })).status, 400, 'the address of a saved key cannot change');
});

test('grading goes down the list, marks failing keys, charges at the answering key price and keeps each key within its amount', async t => {
  const f = await fixture(t);
  const one = (await f.addKey({ remaining: 50 })).body.item;
  const two = (await f.addKey({ baseUrl: 'https://two.example/v1', apiKey: 'sk-synthetic-two-5678', inputPrice: 30000, outputPrice: 90000 })).body.item;
  f.upstream.length = 0; f.grant(1000000);
  assert.equal((await f.grade()).status, 404, 'the service starts switched off');
  assert.equal((await f.request('/api/admin/official-ai', { method: 'PUT', body: { enabled: true } })).status, 200);
  // 1000 input + 100 output tokens at key 1 prices: 1000*1 + 100*2 yuan per million = 0.0012 yuan = 12 units.
  const first = await f.grade();
  assert.equal(first.status, 200); assert.deepEqual(first.body.quizforge, { cost: 12, balance: 1000000 - 12 });
  assert.deepEqual(f.upstream.at(-1), { host: 'one.example', authorization: 'Bearer sk-synthetic-one-1234', model: 'qwen-vl-plus' });
  // Key 1 is down: it is marked as a fault and key 2 answers at its own prices.
  f.replies['one.example'] = () => new Response('', { status: 502 });
  const second = await f.grade();
  assert.equal(second.body.quizforge.cost, 39, '1000*3 + 100*9 yuan per million = 0.0039 yuan');
  let list = await f.keys();
  assert.deepEqual(list.map(item => item.state), ['fault', 'ok']); assert.match(list[0].reason, /HTTP 502/);
  assert.equal(list[0].remaining, 38, 'key 1 spent 12 of 50 units');
  // While key 1 cools down it is skipped; a passing test brings it back.
  f.upstream.length = 0; await f.grade(); assert.deepEqual(f.upstream.map(call => call.host), ['two.example']);
  delete f.replies['one.example'];
  assert.equal((await f.request(`/api/admin/ai-keys/${one.id}/test`, { method: 'POST', body: {} })).body.test.ok, true);
  // Moving key 2 to the top changes the order of tries.
  assert.equal((await f.request('/api/admin/ai-keys/order', { method: 'PUT', body: { ids: [two.id, one.id] } })).status, 200);
  f.upstream.length = 0; await f.grade(); assert.deepEqual(f.upstream.map(call => call.host), ['two.example']);
  // A stopped key is skipped; key 1 then runs out of its amount and is not used again.
  await f.request(`/api/admin/ai-keys/${two.id}/enabled`, { method: 'PUT', body: { enabled: false } });
  for (let i = 0; i < 4; i++) await f.grade();
  list = await f.keys();
  assert.deepEqual(list.map(item => [item.seq, item.state, item.remaining]), [[2, 'disabled', null], [1, 'insufficient', 0]]);
  assert.equal(list[1].reason, '剩余金额已用完');
  const empty = await f.grade(); assert.equal(empty.status, 503); assert.equal(empty.body.error.code, 'AI_DISABLED');
  // Only prices and the remaining amount can be edited; a new amount brings the key back.
  assert.equal((await f.request(`/api/admin/ai-keys/${one.id}`, { method: 'PUT', body: { model: 'other' } })).status, 400);
  const edited = await f.request(`/api/admin/ai-keys/${one.id}`, { method: 'PUT', body: { remaining: 100, inputPrice: 20000 } });
  assert.deepEqual([edited.body.item.state, edited.body.item.remaining, edited.body.item.inputPrice], ['ok', 100, 20000]);
  assert.equal((await f.grade()).status, 200);
  const stats = (await f.request('/api/admin/official-ai')).body.stats;
  assert.equal(stats.totalCalls, 9); assert.ok(stats.totalCost > 0);
  // A rate limit leaves the key ok: the next key is tried, and if all are limited the user is asked to retry.
  await f.request(`/api/admin/ai-keys/${two.id}/enabled`, { method: 'PUT', body: { enabled: true } });
  const limit = () => new Response('{"code":"Throttling"}', { status: 429 });
  f.replies['two.example'] = limit;
  f.upstream.length = 0; assert.equal((await f.grade()).status, 200);
  assert.deepEqual(f.upstream.map(call => call.host), ['two.example', 'one.example'], 'the limited top key is passed over');
  f.replies['one.example'] = limit;
  const limited = await f.grade();
  assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'AI_BUSY');
  assert.deepEqual((await f.keys()).map(item => item.state), ['ok', 'ok'], 'rate limits do not mark keys as faulty');
  delete f.replies['one.example']; delete f.replies['two.example'];
  assert.equal((await f.request(`/api/admin/ai-keys/${two.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await f.keys()).map(item => item.seq), [1]);
  // An expired key is never used.
  f.db.prepare('UPDATE ai_upstreams SET expires=? WHERE id=?').run(Date.now() - 1000, one.id);
  assert.equal((await f.keys())[0].state, 'expired');
  assert.equal((await f.grade()).status, 503);
});

test('the single key saved by the previous version becomes key No. 1', async t => {
  const master = masterKey(MASTER), cipher = encryptKey(master, 'sk-synthetic-legacy-0000');
  const f = await fixture(t, { before(db) {
    db.exec('CREATE TABLE official_ai_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, model TEXT NOT NULL, daily_limit INTEGER NOT NULL, monthly_tokens INTEGER NOT NULL, key_cipher TEXT, key_hint TEXT, updated INTEGER NOT NULL, updated_by TEXT, price_per_million INTEGER NOT NULL DEFAULT 30000)');
    db.prepare('INSERT INTO official_ai_config VALUES (1,0,?,0,0,?,?,?,NULL,30000)').run('qwen-vl-plus', cipher, 'sk-…0000', Date.now());
  } });
  const [item] = await f.keys();
  assert.deepEqual({ seq: item.seq, note: item.note, host: item.host, inputPrice: item.inputPrice, outputPrice: item.outputPrice, remaining: item.remaining, expires: item.expires, enabled: item.enabled, readable: item.readable },
    { seq: 1, note: '原有 Key', host: 'upstream.example', inputPrice: 30000, outputPrice: 30000, remaining: null, expires: null, enabled: true, readable: true });
  assert.equal(f.db.prepare('SELECT key_cipher FROM official_ai_config').get().key_cipher, null, 'the old column is cleared');
});

test('redeem codes: created enabled, listed in full while unused, note and switch editable, stats in yuan', async t => {
  const f = await fixture(t), later = Date.now() + 7 * 86400000;
  assert.equal((await f.request('/api/admin/ai-codes', { method: 'POST', user: 'alice', body: { count: 1, amount: 10000, expires: later } })).status, 403);
  assert.equal((await f.request('/api/admin/ai-codes', { method: 'POST', body: { count: 1, amount: 10000, expires: Date.now() - 1 } })).status, 400, 'expiry must be in the future');
  const made = await f.request('/api/admin/ai-codes', { method: 'POST', body: { count: 3, amount: 50000, expires: later, note: '首批' } });
  assert.equal(made.status, 201); assert.deepEqual(made.body.items.map(item => item.seq), [1, 2, 3]);
  let list = (await f.request('/api/admin/ai-codes')).body;
  assert.deepEqual(list.items.map(item => [item.seq, item.state, item.enabled, item.full]), [[3, 'available', true, true], [2, 'available', true, true], [1, 'available', true, true]]);
  assert.equal(list.items.find(item => item.seq === 1).code, made.body.items[0].code);
  assert.deepEqual(list.stats, { total: 150000, redeemed: 0 });
  const [code] = made.body.items;
  assert.equal((await f.request(`/api/admin/ai-codes/${code.id}`, { method: 'PUT', body: { note: '改过的备注' } })).status, 200);
  assert.equal((await f.request(`/api/admin/ai-codes/${code.id}`, { method: 'PUT', body: { amount: 1 } })).status, 400, 'only the note and the switch can change');
  await f.request(`/api/admin/ai-codes/${code.id}`, { method: 'PUT', body: { enabled: false } });
  assert.throws(() => f.app.aiPoints.redeem(f.users.alice.id, code.code), { code: 'REDEEM_CODE_INVALID' }, 'a stopped code cannot be redeemed');
  await f.request(`/api/admin/ai-codes/${code.id}`, { method: 'PUT', body: { enabled: true } });
  assert.deepEqual(f.app.aiPoints.redeem(f.users.alice.id, code.code), { added: 50000, balance: 50000 });
  list = (await f.request('/api/admin/ai-codes')).body;
  const used = list.items.find(item => item.seq === 1);
  assert.deepEqual([used.state, used.note, used.redeemedBy, used.full], ['redeemed', '改过的备注', 'alice', false]);
  assert.deepEqual(list.stats, { total: 150000, redeemed: 50000 });
  assert.equal((await f.request(`/api/admin/ai-codes/${code.id}`, { method: 'PUT', body: { enabled: false } })).status, 409);
  const audit = f.db.prepare("SELECT action,detail FROM admin_audit WHERE action LIKE 'ai-code%'").all();
  assert.equal(JSON.stringify(audit).includes(code.code), false, 'the audit log holds no full code');
});

test('administrators set a user balance with a required reason; it is audited and shows in the history', async t => {
  const f = await fixture(t), route = `/api/admin/users/${f.users.alice.id}/ai-balance`;
  assert.equal((await f.request(route, { user: 'alice' })).status, 403);
  assert.equal((await f.request(route, { method: 'PUT', body: { balance: 200000 } })).status, 400, 'a reason is required');
  assert.equal((await f.request(route, { method: 'PUT', body: { balance: -1, reason: 'x' } })).status, 400);
  f.grant(50000);
  const set = await f.request(route, { method: 'PUT', body: { balance: 200000, reason: '内测补偿' } });
  assert.equal(set.status, 200); assert.equal(set.body.balance, 200000, 'the new value replaces the old one');
  assert.deepEqual(set.body.history.map(entry => [entry.kind, entry.delta, entry.note]), [['admin', 150000, '内测补偿']]);
  const audit = f.db.prepare("SELECT detail FROM admin_audit WHERE action='ai-balance-set'").all().map(row => JSON.parse(row.detail));
  assert.deepEqual(audit, [{ before: 50000, after: 200000, reason: '内测补偿' }]);
  assert.equal(f.app.aiPoints.balance(f.users.alice.id), 200000);
  assert.equal((await f.request(`/api/admin/users/${randomUUID()}/ai-balance`, { method: 'PUT', body: { balance: 1, reason: 'x' } })).status, 404);
});
