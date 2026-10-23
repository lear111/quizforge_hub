import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { initializeContacts, normalizePhone, loginContact } from '../accounts.mjs';
import { createContactCodes } from '../contact-codes.mjs';
import { aliyunAuthorization, createSmsProvider, signedSmsRequest, smsSettings } from '../sms.mjs';
import { createInvitations } from '../invitations.mjs';
import { HubLogin } from '../cloud/hub-login.mjs';
import { hubAccount } from '../cloud/hub-ai.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const password = 'synthetic-password-123';
const status = expected => error => error.status === expected;
const phone = value => ({ channel: 'phone', value: normalizePhone(value) });
const makeProvider = (sent = new Map(), extra = {}) => ({ ready: true, pepper: 'synthetic-contact-pepper-'.repeat(3), siteKey: 'synthetic-site',
  verify: async token => token === 'valid', send: async (target, code) => { sent.set(target, code); }, ...extra });

test('contact parsing accepts one normalized email or mainland phone, never ambiguous identities', () => {
  for (const value of ['13800138000', '+86 13800138000', '8613800138000']) assert.equal(normalizePhone(value), '+8613800138000');
  for (const value of ['+821012345678', '12800138000', '1380013800', '13800138000\nX', null]) assert.equal(normalizePhone(value), null);
  assert.deepEqual(loginContact({ identifier: ' Alice@Example.test ', password }), { channel: 'email', value: 'alice@example.test' });
  assert.deepEqual(loginContact({ identifier: '13800138000' }), phone('13800138000'));
  for (const input of [{ email: 'a@b.test', phone: '13800138000' }, { identifier: '13800138000', email: 'a@b.test' }, { email: '13800138000' }, { phone: 'a@b.test' }, {}]) assert.equal(loginContact(input), null);
});

test('SMS uses the official ACS3 reference signature and fixed PNVS API; secrets stay server-side', async () => {
  // Alibaba Cloud's published fixed-parameter reference, not an implementation-generated fixture.
  const auth = aliyunAuthorization({ accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret' }, { query: 'ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai', headers: {
    host: 'ecs.cn-shanghai.aliyuncs.com', 'x-acs-action': 'RunInstances', 'x-acs-content-sha256': hash(''), 'x-acs-date': '2023-10-26T10:22:32Z',
    'x-acs-signature-nonce': '3156853299f313e23d1673dc12e1703d', 'x-acs-version': '2014-05-26' } });
  assert.ok(auth.endsWith('Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0'));
  const settings = smsSettings({ ALIYUN_SMS_ENABLED: '1', ALIYUN_SMS_ACCESS_KEY_ID: 'synthetic-id', ALIYUN_SMS_ACCESS_KEY_SECRET: 'synthetic-secret',
    ALIYUN_SMS_SIGN_NAME: '平台签名', ALIYUN_SMS_TEMPLATE_CODE: '100001', SMS_CODE_PEPPER: 'x'.repeat(64), TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'captcha' });
  assert.equal(settings.ready, true); assert.equal(smsSettings({ ALIYUN_SMS_ENABLED: '1' }).ready, false);
  const request = signedSmsRequest(settings, '+8613800138000', '123456', 'synthetic-out-id', new Date(0), 'synthetic-nonce');
  const url = new URL(request.url); assert.equal(url.origin, 'https://dypnsapi.aliyuncs.com');
  assert.equal(url.searchParams.get('PhoneNumber'), '13800138000');
  assert.deepEqual(JSON.parse(url.searchParams.get('TemplateParam')), { code: '123456', min: '10' });
  assert.equal(url.searchParams.get('ReturnVerifyCode'), 'false'); assert.equal(url.searchParams.get('AutoRetry'), '0');
  assert.equal(url.searchParams.get('ValidTime'), '600'); assert.equal(url.searchParams.get('OutId'), 'synthetic-out-id');
  assert.equal(request.headers['x-acs-action'], 'SendSmsVerifyCode'); assert.equal(url.href.includes('synthetic-secret'), false);
  const calls = [], provider = createSmsProvider(settings, async (target, options) => {
    calls.push({ target, options }); return new Response(JSON.stringify(target.includes('siteverify') ? { success: true, hostname: 'hub.test', action: 'register_phone' } : { Code: 'OK', Success: true }));
  });
  assert.equal(await provider.verify('valid', '127.0.0.1', 'hub.test', 'register_phone'), true);
  assert.equal(await provider.verify('valid', '127.0.0.1', 'other.test', 'register_phone'), false);
  assert.equal(await provider.verify('valid', '127.0.0.1', 'hub.test', 'bind_contact'), false);
  await provider.send('+8613800138000', '123456', 'out');
  assert.equal(calls.at(-1).options.redirect, 'error'); assert.equal(calls.at(-1).options.credentials, 'omit');
  assert.equal('Cookie' in calls.at(-1).options.headers, false);
  const rejected = createSmsProvider(settings, async () => new Response(JSON.stringify({ Code: 'ISP.UNKNOWN', Message: 'private provider diagnostic', Success: false })));
  await assert.rejects(rejected.send('+8613800138000', '123456', 'out'), error => error.message === 'SmsProviderRejected');
});

test('SMS challenges bind contact, account and purpose; guessing persists and consumption is atomic', async () => {
  const db = new DatabaseSync(':memory:'); let time = Date.now(); const sent = new Map(), provider = makeProvider(sent);
  const start = () => createContactCodes(db, { phone: provider }, () => time), codes = start(), contact = phone('13800138000');
  await codes.send(contact, 'bind:alice', 'ip', 'valid', 'hub.test'); const code = sent.get(contact.value);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM contact_codes').all()).includes(code), false);
  assert.throws(() => codes.consume(contact, 'register', code, () => {}), status(400));
  assert.throws(() => codes.consume(contact, 'bind:bob', code, () => {}), status(400));
  assert.throws(() => codes.consume(phone('13900139000'), 'bind:alice', code, () => {}), status(400));
  for (let i = 0; i < 5; i++) assert.throws(() => codes.consume(contact, 'bind:alice', 'bad', () => {}), status(400));
  assert.throws(() => start().consume(contact, 'bind:alice', code, () => {}), status(400));
  time += 60001; await codes.send(contact, 'bind:alice', 'ip', 'valid', 'hub.test'); const fresh = sent.get(contact.value);
  assert.throws(() => codes.consume(contact, 'bind:alice', fresh, () => { throw new Error('account-conflict'); }), /account-conflict/);
  let changed = 0; codes.consume(contact, 'bind:alice', fresh, () => changed++); assert.equal(changed, 1);
  assert.throws(() => codes.consume(contact, 'bind:alice', fresh, () => changed++), status(400));
  time += 60001; await codes.send(contact, 'register', 'ip', 'valid', 'hub.test'); time += 600000;
  assert.throws(() => codes.consume(contact, 'register', sent.get(contact.value), () => {}), status(400)); db.close();
});

test('paid SMS reservations survive failures, concurrency, restart and account/purpose changes', async () => {
  const db = new DatabaseSync(':memory:'); let calls = 0;
  const provider = makeProvider(new Map(), { send: async () => { calls++; throw new Error('timeout'); } });
  const start = () => createContactCodes(db, { phone: provider }, Date.now, 1), codes = start(), contact = phone('13800138000');
  const results = await Promise.allSettled([codes.send(contact, 'register', 'ip', 'valid', 'hub.test'), codes.send(contact, 'register', 'ip', 'valid', 'hub.test')]);
  assert.deepEqual(results.map(result => result.reason.status).sort(), [429, 503]); assert.equal(calls, 1);
  await assert.rejects(start().send(contact, 'bind:other', 'other-ip', 'valid', 'hub.test'), status(429));
  await assert.rejects(start().send(phone('13900139000'), 'register', 'other-ip', 'valid', 'hub.test'), status(429));
  assert.throws(() => codes.consume(contact, 'register', '123456', () => {}), status(400)); db.close();
});

async function fixture(t, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-phone-auth-')), emails = new Map(), phones = new Map();
  const providers = { mailProvider: makeProvider(emails), smsProvider: makeProvider(phones) };
  const app = await createApp({ dataDir, ...providers, ...extra });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`, db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (route, body, cookie, headers = {}) => fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function register(identifier, name = '合成用户', invitationCode) {
    const isPhone = !identifier.includes('@'), contact = isPhone ? { phone: identifier } : { email: identifier };
    const sent = await request('/api/auth/' + (isPhone ? 'phone-code' : 'email-code'), { ...contact, captchaToken: 'valid', invitationCode });
    assert.equal(sent.status, 200, await sent.text());
    const code = (isPhone ? phones : emails).get(isPhone ? normalizePhone(identifier) : identifier);
    const response = await request('/api/auth/register', { identifier, password, name, code, invitationCode });
    assert.equal(response.status, 201, await response.clone().text());
    return { user: (await response.json()).user, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  return { app, dataDir, db, request, register, emails, phones, providers };
}

test('phone registration requires CAPTCHA, verification and an invitation; email stays optional and private', async t => {
  const f = await fixture(t, { invitationRequired: true });
  const adminId = randomUUID(); f.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(adminId, 'admin@example.test', 'admin', 'unused', 1, new Date().toISOString());
  const invitationCode = createInvitations(f.db).create(adminId)[0].code;
  const rejected = await f.request('/api/auth/phone-code', { phone: '13800138000', captchaToken: 'valid' }); assert.equal(rejected.status, 400); assert.equal(f.phones.size, 0);
  assert.equal((await f.request('/api/auth/phone-code', { phone: '13800138000', captchaToken: 'bad', invitationCode })).status, 400);
  assert.equal((await f.request('/api/auth/register', { phone: '13800138000', password, name: 'test', code: '123456', invitationCode })).status, 400);
  const account = await f.register('13800138000', '手机账号', invitationCode);
  assert.equal(account.user.email, null); assert.equal(account.user.phone, '+8613800138000');
  assert.equal(f.db.prepare('SELECT user_id FROM invitations WHERE used IS NOT NULL').get().user_id, account.user.id);
  const login = await f.request('/api/auth/login', { identifier: '+8613800138000', password }); assert.equal(login.status, 200); assert.equal((await login.json()).user.id, account.user.id);
  assert.equal((await f.request('/api/auth/login', { identifier: '13800138000', password: 'wrong-password' })).status, 401);
  const config = await (await f.request('/api/config')).json(); assert.deepEqual(config.registrationMethods, { email: true, phone: true });
  assert.equal(JSON.stringify(config).includes('pepper'), false); assert.equal((await f.request('/api/me')).status, 200);
  assert.equal((await f.request('/api/me')).headers.get('set-cookie'), null);
  assert.equal((await f.request('/api/auth/phone-code', { phone: '13900139000', captchaToken: 'valid', invitationCode })).status, 400);
  assert.equal((await f.request('/api/auth/phone-code', { phone: '13900139000', captchaToken: 'valid' }, null, { Origin: 'https://evil.test' })).status, 403);
});

test('two phone registrations racing one invitation commit one user, one phone and one consumed code', async t => {
  const f = await fixture(t, { invitationRequired: true }), adminId = randomUUID();
  f.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(adminId, 'admin@example.test', 'admin', 'unused', 1, new Date().toISOString());
  const invitationCode = createInvitations(f.db).create(adminId)[0].code;
  for (const number of ['13800138000', '13900139000']) assert.equal((await f.request('/api/auth/phone-code', { phone: number, captchaToken: 'valid', invitationCode })).status, 200);
  const responses = await Promise.all(['13800138000', '13900139000'].map(number => f.request('/api/auth/register', { phone: number, password, name: number.slice(-4), code: f.phones.get(normalizePhone(number)), invitationCode })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users WHERE admin=0').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM user_phones').get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM contact_codes WHERE state='sent'").get().n, 1);
  assert.equal(f.db.prepare('SELECT user_id FROM user_phones').get().user_id, f.db.prepare('SELECT user_id FROM invitations WHERE used IS NOT NULL').get().user_id);
});

async function connectDevice(f, cookie, client) {
  const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
  const redirect_uri = client === 'web' ? 'http://127.0.0.1:8787/hub/connect/callback' : 'quizforge://hub/connect';
  const query = new URLSearchParams({ v: '1', client, redirect_uri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', device_name: client });
  const page = await f.request('/connect/authorize?' + query, undefined, cookie); assert.equal(page.status, 200);
  const request = /data-request="([a-f0-9]{64})"/.exec(await page.text())[1];
  const consent = await f.request('/api/connect/authorize', { request, decision: 'allow' }, cookie); assert.equal(consent.status, 200);
  const back = new URL((await consent.json()).redirect); assert.equal(back.searchParams.get('state'), state);
  const token = await f.request('/api/connect/token', { v: 1, client, code: back.searchParams.get('code'), code_verifier: verifier, redirect_uri });
  assert.equal(token.status, 200); return (await token.json()).token;
}

test('binding keeps one account, both Web/Android device tokens and the same AI balance and redemption history', async t => {
  const f = await fixture(t, { officialAiMasterKey: randomBytes(32).toString('base64'), officialAiFetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"score":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } })) });
  const account = await f.register('13800138000'); f.app.aiConfig.setEnabled('test', true);
  await f.app.aiConfig.addKey({ note: 'synthetic only', baseUrl: 'https://model.example.test/v1', model: 'test', apiKey: 'synthetic-model-key', inputPrice: 10000, outputPrice: 10000 });
  f.db.prepare('INSERT INTO ai_points VALUES (?,?,?)').run(account.user.id, 42000, Date.now());
  const ledger = randomUUID(); f.db.prepare('INSERT INTO ai_points_ledger VALUES (?,?,?,?,?,?)').run(ledger, account.user.id, 42000, 'redeem', 'synthetic-redeem', Date.now());
  const tokens = await Promise.all(['web', 'android'].map(client => connectDevice(f, account.cookie, client)));
  const before = f.db.prepare('SELECT id,user_id,token FROM connect_devices ORDER BY id').all();
  const binding = { identifier: 'bound@example.test', password };
  assert.equal((await f.request('/api/account/contact-code', { ...binding, captchaToken: 'valid' })).status, 401);
  assert.equal((await f.request('/api/account/contact-code', { ...binding, password: 'incorrect-password', captchaToken: 'valid' }, account.cookie)).status, 401);
  assert.equal((await f.request('/api/account/contact-code', { ...binding, captchaToken: 'valid' }, account.cookie)).status, 200);
  const code = f.emails.get(binding.identifier);
  assert.equal((await f.request('/api/auth/register', { ...binding, code, name: 'not-another-account' })).status, 400, 'a binding code is not a registration code');
  assert.equal((await f.request('/api/account/contact', { ...binding, code }, account.cookie)).status, 200);
  const login = await f.request('/api/auth/login', binding); assert.equal(login.status, 200); assert.equal((await login.json()).user.id, account.user.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.deepEqual(f.db.prepare('SELECT id,user_id,token FROM connect_devices ORDER BY id').all(), before);
  assert.equal(f.db.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(account.user.id).balance, 42000);
  assert.equal(f.db.prepare('SELECT user_id FROM ai_points_ledger WHERE id=?').get(ledger).user_id, account.user.id);
  for (const token of tokens) {
    const me = await f.request('/api/connect/me', undefined, undefined, { Authorization: 'Bearer ' + token });
    assert.equal(me.status, 200); const value = await me.json(); assert.equal(value.ai.balance, 42000); assert.deepEqual(Object.keys(value.user), ['name']);
  }
  for (const token of tokens) {
    const graded = await f.request('/api/ai/v1/chat/completions', { model: 'quizforge-official', messages: [{ role: 'user', content: 'synthetic grading input' }], max_tokens: 10 }, undefined, { Authorization: 'Bearer ' + token });
    assert.equal(graded.status, 200, await graded.clone().text());
  }
  assert.equal(f.db.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(account.user.id).balance, 41998);
  assert.equal(f.db.prepare('SELECT calls FROM official_ai_usage WHERE user_id=?').get(account.user.id).calls, 2);
  assert.equal((await f.request('/api/account/contact', { ...binding, code }, account.cookie)).status, 409);
});

test('supplementary binding cannot take a contact from another account or use another account’s challenge', async t => {
  const f = await fixture(t), alice = await f.register('alice@example.test'), bob = await f.register('bob@example.test');
  const target = { identifier: '13800138000', password };
  assert.equal((await f.request('/api/account/contact-code', { ...target, captchaToken: 'valid' }, alice.cookie)).status, 200);
  const code = f.phones.get('+8613800138000');
  assert.equal((await f.request('/api/account/contact', { ...target, code }, bob.cookie)).status, 400);
  assert.equal((await f.request('/api/account/contact', { ...target, code }, alice.cookie)).status, 200);
  assert.equal((await f.request('/api/account/contact-code', { ...target, captchaToken: 'valid' }, bob.cookie)).status, 409);
  assert.equal(f.db.prepare('SELECT user_id FROM user_phones WHERE phone=?').get('+8613800138000').user_id, alice.user.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
});

test('an unavailable SMS channel leaves email registration open and returns no credentials in configuration', async t => {
  const f = await fixture(t, { smsProvider: { ready: false } });
  const config = await (await f.request('/api/config')).json(); assert.deepEqual(config.registrationMethods, { email: true, phone: false });
  assert.equal((await f.request('/api/auth/phone-code', { phone: '13800138000', captchaToken: 'valid' })).status, 503);
  assert.equal((await f.request('/api/auth/register', { phone: '13800138000', password, name: 'test', code: '123456' })).status, 503);
  assert.ok((await f.register('email-only@example.test')).user.id); assert.equal(f.phones.size, 0);
});

test('email users can bind a phone, while disabling SMS keeps existing phone/password login available', async t => {
  const f = await fixture(t), account = await f.register('email@example.test');
  const input = { identifier: '13900139000', password };
  assert.equal((await f.request('/api/account/contact-code', { ...input, captchaToken: 'valid' }, account.cookie)).status, 200);
  assert.equal((await f.request('/api/account/contact', { ...input, code: f.phones.get('+8613900139000') }, account.cookie)).status, 200);
  assert.equal((await (await f.request('/api/auth/login', input)).json()).user.id, account.user.id);
  f.providers.smsProvider.ready = false;
  assert.equal((await f.request('/api/auth/login', input)).status, 200);
  assert.equal((await f.request('/api/auth/phone-code', { phone: '13700137000', captchaToken: 'valid' })).status, 503);
  assert.equal((await (await f.request('/api/config')).json()).registrationMethods.phone, false);
});

test('legacy email schema upgrade preserves sessions, device credentials, AI balances and foreign key references', () => {
  const db = new DatabaseSync(':memory:'); const id = randomUUID();
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
    CREATE TABLE owned_records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER);
    CREATE TABLE connect_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token TEXT UNIQUE);
    CREATE TABLE ai_points(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL,updated INTEGER);
    CREATE INDEX keep_user_name ON users(name);`);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, 'old@example.test', 'old', 'unchanged-hash', 0, '2026-01-01');
  db.prepare('INSERT INTO owned_records VALUES (?,?,?)').run('record', id, 'synthetic saved record');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('session'), id, 9999999999999);
  db.prepare('INSERT INTO connect_devices VALUES (?,?,?)').run('device', id, hash('device-token'));
  db.prepare('INSERT INTO ai_points VALUES (?,?,?)').run(id, 88888, 1);
  const tables = ['users', 'owned_records', 'sessions', 'connect_devices', 'ai_points'], before = tables.map(table => db.prepare('SELECT * FROM ' + table).all());
  initializeContacts(db); initializeContacts(db);
  assert.deepEqual(tables.map(table => db.prepare('SELECT * FROM ' + table).all()), before);
  assert.equal(db.prepare('PRAGMA table_info(users)').all().find(column => column.name === 'email').notnull, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='keep_user_name'").get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.prepare('INSERT INTO owned_records VALUES (?,?,?)').run('bad', 'missing', 'x'));
  db.close();
});

test('the practice identity adapter accepts a phone-only Hub account without inventing an email', async t => {
  const user = { id: randomUUID(), name: '手机账号', email: null, phone: '+8613800138000', admin: 0 };
  const f = await fixture(t, { identityProvider: async () => user });
  const response = await f.request('/api/me'); assert.equal(response.status, 200); assert.deepEqual((await response.json()).user, user);
  assert.equal(f.db.prepare('SELECT email FROM users WHERE id=?').get(user.id).email, null);
  assert.equal(f.db.prepare('SELECT phone FROM user_phones WHERE user_id=?').get(user.id).phone, user.phone);
  assert.equal((await f.request('/api/auth/register', { identifier: '13800138000', password, code: '123456', name: 'test' })).status, 403);
});

test('the actual Hub session bridge and cloud AI account relay preserve a phone-only identity', async t => {
  const f = await fixture(t), account = await f.register('13800138000');
  const bridge = new HubLogin({ practiceOrigin: 'https://practice.example.test', hubOrigin: 'https://hub.example.test', authPort: f.app.server.address().port });
  const identity = await bridge.identity(account.cookie.split('=')[1]); assert.deepEqual(identity, account.user);
  const relay = await hubAccount({ manageUrl: 'https://hub.example.test/manage/', call: async () => ({ status: 200, body: { user: identity, ai: { enabled: true, balance: 42000 } } }) }, {});
  assert.equal(relay.connected, true); assert.equal(relay.user.email, null); assert.equal(relay.user.phone, '+8613800138000'); assert.equal(relay.ai.balance, 42000);
});
