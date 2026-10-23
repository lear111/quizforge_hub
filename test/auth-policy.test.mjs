import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { createInvitations } from '../invitations.mjs';
import { setContactVerified } from '../accounts.mjs';
import { createCaptchaProvider } from '../captcha.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const password = 'synthetic-auth-policy-password';
const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = value => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(value, salt, 64).toString('hex'); };
const storedPassword = passwordHash(password);
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qfh-auth-policy-'));
  let time = Date.now(), app, origin;
  const sent = new Map(), captchaCalls = [];
  const captcha = { ready: true, siteKey: 'synthetic-public-key', verify: async (token, ip, hostname, action) => { captchaCalls.push(action); return token === 'valid'; } };
  const provider = channel => ({ ready: true, deliveryReady: true, captchaReady: true, pepper: 'synthetic-' + channel + '-pepper-'.repeat(5),
    verify: captcha.verify, send: async (target, code) => sent.set(target, code) });
  const emailProvider = provider('email'), phoneProvider = provider('phone');
  Object.assign(emailProvider, options.email); Object.assign(phoneProvider, options.phone); Object.assign(captcha, options.captcha);
  const start = async () => {
    app = await createApp({ dataDir: directory, mailProvider: emailProvider, smsProvider: phoneProvider, captchaProvider: captcha,
      invitationRequired: true, adminEnabled: true, now: () => time });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + app.server.address().port;
  };
  const stop = async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); };
  await start();
  const actors = {};
  const seed = (channel, contact, { admin = false, verified = true } = {}) => {
    const id = randomUUID();
    app.db.exec('BEGIN IMMEDIATE');
    try {
      app.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, channel === 'email' ? contact : null, '合成账号', storedPassword, +admin, new Date().toISOString());
      if (channel === 'phone') app.db.prepare('INSERT INTO user_phones VALUES (?,?,?)').run(id, contact, verified ? Date.now() : 0);
      setContactVerified(app.db, id, { channel, value: contact }, verified);
      app.db.exec('COMMIT');
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
    return id;
  };
  for (const [role, isAdmin] of [['admin', true], ['ordinary', false]]) {
    const id = seed('email', role + '@example.test', { admin: isAdmin }), token = (isAdmin ? 'a' : 'b').repeat(64);
    actors[role] = { id, token }; app.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), id, Date.now() + 3600000);
  }
  const request = (route, body, { actor, method = body === undefined ? 'GET' : 'POST', badOrigin = false } = {}) => fetch(origin + route, {
    method, headers: { Origin: badOrigin ? 'https://untrusted.example' : origin, 'Content-Type': 'application/json', ...(actor ? { Cookie: 'qfh_session=' + actors[actor].token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  });
  const policy = async () => (await (await request('/api/admin/authentication', undefined, { actor: 'admin' })).json()).policy;
  const setting = async (changes, extra = {}) => request('/api/admin/authentication', { ...await policy(), ...changes }, { actor: 'admin', method: 'PUT', ...extra });
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get db() { return app.db; }, get authPolicy() { return app.authPolicy; }, actors, seed, request, policy, setting, sent, captcha, captchaCalls,
    advance: () => { time += 61000; }, restart: async () => { await stop(); await start(); } };
}

test('authentication settings are admin-only, audited, persistent, revision checked and share the legacy invitation setting', async t => {
  const f = await fixture(t), route = '/api/admin/authentication';
  assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request(route, undefined, { actor: 'ordinary' })).status, 403);
  assert.equal((await f.setting({ loginCaptchaRequired: true }, { badOrigin: true })).status, 403);
  assert.equal((await f.setting({ registrationCodeRequired: 'false' })).status, 400);
  assert.equal((await f.setting({ unknown: false })).status, 400);
  const before = await f.policy();
  assert.equal((await f.setting({ invitationRequired: false, registrationCaptchaRequired: false })).status, 200);
  const current = await f.policy(); assert.equal(current.revision, before.revision + 1);
  assert.equal((await f.request(route, { ...before, loginCodeRequired: true }, { actor: 'admin', method: 'PUT' })).status, 409);
  const config = await (await f.request('/api/config')).json(); assert.equal(config.invitationRequired, false); assert.equal(config.authPolicy.registrationCaptchaRequired, false);
  await f.restart(); assert.deepEqual(await f.policy(), current);
  assert.equal((await f.request('/api/admin/invitations/settings', { invitationRequired: true }, { actor: 'admin', method: 'PUT' })).status, 200);
  assert.equal((await f.policy()).invitationRequired, true); assert.equal((await f.policy()).revision, current.revision + 1);
  const stable = await f.policy();
  f.db.exec("CREATE TRIGGER fail_auth_audit BEFORE INSERT ON admin_audit WHEN NEW.action='authentication-policy-updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.setting({ invitationRequired: false, registrationCodeRequired: false })).status, 500);
  assert.deepEqual(await f.policy(), stable, 'failed audit must roll back both authentication and invitation policy');
});

for (const channel of ['email', 'phone']) for (const codeRequired of [false, true]) for (const captchaRequired of [false, true]) {
  test(`registration ${channel}: code=${codeRequired}, captcha=${captchaRequired} are independently enforced`, async t => {
    const f = await fixture(t), target = channel === 'email' ? 'register@example.test' : '+8613800138000';
    assert.equal((await f.setting({ registrationCodeRequired: codeRequired, registrationCaptchaRequired: captchaRequired })).status, 200);
    const [{ code: invitationCode, id: invitationId }] = createInvitations(f.db).create(f.actors.admin.id);
    const input = { identifier: target, name: '测试用户名', password, invitationCode, captchaToken: 'valid' };
    assert.equal((await f.request('/api/auth/register', { ...input, invitationCode: undefined })).status, 400);
    const codeRoute = '/api/auth/' + (channel === 'email' ? 'email-code' : 'phone-code');
    if (codeRequired) {
      if (captchaRequired) assert.equal((await f.request(codeRoute, { [channel]: target, invitationCode, captchaToken: 'bad' })).status, 400);
      assert.equal((await f.request(codeRoute, { [channel]: target, invitationCode, captchaToken: captchaRequired ? 'valid' : undefined })).status, 200);
      assert.equal((await f.request('/api/auth/register', { ...input, code: 'bad' })).status, 400);
      input.code = f.sent.get(target);
    } else {
      assert.equal((await f.request(codeRoute, { [channel]: target, invitationCode })).status, 400, 'disabled verification cannot be used as a paid send endpoint');
      if (captchaRequired) assert.equal((await f.request('/api/auth/register', { ...input, captchaToken: 'bad' })).status, 400);
    }
    const response = await f.request('/api/auth/register', input);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { user } = await response.json(); assert.equal(user.name, input.name);
    assert.deepEqual(user.unverifiedContacts || [], codeRequired ? [] : [channel]);
    assert.equal(f.db.prepare('SELECT user_id FROM invitations WHERE id=?').get(invitationId).user_id, user.id);
    if (channel === 'phone') assert.equal(f.db.prepare('SELECT verified FROM user_phones WHERE user_id=?').get(user.id).verified > 0, codeRequired);
    assert.equal(f.captchaCalls.length > 0, captchaRequired);
    const config = await (await f.request('/api/config')).json(); assert.equal(JSON.stringify(config).includes('pepper'), false);
  });
}

for (const channel of ['email', 'phone']) for (const codeRequired of [false, true]) for (const captchaRequired of [false, true]) {
  test(`login ${channel}: password plus code=${codeRequired}, captcha=${captchaRequired} must complete before a session`, async t => {
    const f = await fixture(t), target = channel === 'email' ? 'login@example.test' : '+8613900139000';
    const id = f.seed(channel, target, { verified: false });
    assert.equal((await f.setting({ loginCodeRequired: codeRequired, loginCaptchaRequired: captchaRequired })).status, 200);
    const input = { identifier: target, password, captchaToken: 'valid' };
    const wrongPassword = await f.request('/api/auth/' + (codeRequired ? 'login-code' : 'login'), { ...input, password: 'incorrect-password' });
    assert.equal(wrongPassword.status, 401); assert.equal(wrongPassword.headers.get('set-cookie'), null); assert.equal(f.sent.size, 0);
    if (codeRequired) {
      if (captchaRequired) assert.equal((await f.request('/api/auth/login-code', { ...input, captchaToken: 'bad' })).status, 400);
      assert.equal((await f.request('/api/auth/login-code', { ...input, captchaToken: captchaRequired ? 'valid' : undefined })).status, 200);
      const missing = await f.request('/api/auth/login', input); assert.equal(missing.status, 400); assert.equal(missing.headers.get('set-cookie'), null);
      assert.equal((await f.request('/api/auth/login', { ...input, code: 'bad' })).status, 400);
      input.code = f.sent.get(target);
    } else if (captchaRequired) {
      const missing = await f.request('/api/auth/login', { ...input, captchaToken: undefined }); assert.equal(missing.status, 400); assert.equal(missing.headers.get('set-cookie'), null);
    }
    const calls = f.captchaCalls.length;
    const response = await f.request('/api/auth/login', input); assert.equal(response.status, 200);
    assert.ok(response.headers.get('set-cookie')); const { user } = await response.json(); assert.equal(user.id, id);
    if (codeRequired) {
      assert.equal(f.captchaCalls.length, calls, 'the CAPTCHA accepted before sending must not be reused at final login');
      assert.deepEqual(user.unverifiedContacts || [], []);
      assert.equal((await f.request('/api/auth/login', input)).status, 400, 'a successful code cannot log in again');
    }
    assert.equal(f.captchaCalls.length > 0, captchaRequired);
  });
}

test('strengthening CAPTCHA requirements invalidates weaker outstanding registration and login challenges', async t => {
  const f = await fixture(t);
  assert.equal((await f.setting({ invitationRequired: false, registrationCaptchaRequired: false, loginCodeRequired: true })).status, 200);
  const input = { email: 'strengthen@example.test', name: '测试', password };
  assert.equal((await f.request('/api/auth/email-code', input)).status, 200); const old = f.sent.get(input.email);
  assert.equal((await f.setting({ registrationCaptchaRequired: true })).status, 200);
  assert.equal((await f.request('/api/auth/register', { ...input, code: old })).status, 409);
  assert.equal(f.db.prepare('SELECT 1 FROM users WHERE email=?').get(input.email), undefined);
  f.advance(); assert.equal((await f.request('/api/auth/email-code', { ...input, captchaToken: 'valid' })).status, 200);
  assert.equal((await f.request('/api/auth/register', { ...input, code: f.sent.get(input.email) })).status, 201);
  f.advance(); assert.equal((await f.request('/api/auth/login-code', input)).status, 200); const weak = f.sent.get(input.email);
  assert.equal((await f.setting({ loginCaptchaRequired: true })).status, 200);
  const rejected = await f.request('/api/auth/login', { ...input, code: weak }); assert.equal(rejected.status, 409); assert.equal(rejected.headers.get('set-cookie'), null);
});

test('password hashing and CAPTCHA waits cannot bypass requirements enabled during the request', async t => {
  const f = await fixture(t);
  await f.setting({ invitationRequired: false, registrationCodeRequired: false });
  let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.captcha.verify = async () => { arrived(); await gate; return true; };
  const pending = f.request('/api/auth/register', { email: 'race@example.test', name: '测试', password, captchaToken: 'valid' });
  await waiting; assert.equal((await f.setting({ registrationCodeRequired: true })).status, 200); release();
  const response = await pending; assert.equal(response.status, 409); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.db.prepare('SELECT 1 FROM users WHERE email=?').get('race@example.test'), undefined);
});

test('codes for registration or an earlier password cannot authenticate a later login', async t => {
  const f = await fixture(t); await f.setting({ invitationRequired: false, loginCodeRequired: true });
  const input = { email: 'purpose@example.test', password, captchaToken: 'valid' };
  assert.equal((await f.request('/api/auth/email-code', input)).status, 200); const registrationCode = f.sent.get(input.email);
  const id = f.seed('email', input.email); f.advance();
  assert.equal((await f.request('/api/auth/login', { ...input, code: registrationCode })).status, 400);
  assert.equal((await f.request('/api/auth/login-code', input)).status, 200); const oldLogin = f.sent.get(input.email);
  const changedPassword = 'synthetic-changed-password'; f.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(changedPassword), id);
  const response = await f.request('/api/auth/login', { ...input, password: changedPassword, code: oldLogin }); assert.equal(response.status, 400); assert.equal(response.headers.get('set-cookie'), null);
});

test('enabling login codes during an in-flight CAPTCHA cannot issue a password-only session', async t => {
  const f = await fixture(t); f.seed('email', 'login-race@example.test'); await f.setting({ loginCaptchaRequired: true });
  let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.captcha.verify = async () => { arrived(); await gate; return true; };
  const pending = f.request('/api/auth/login', { email: 'login-race@example.test', password, captchaToken: 'valid' });
  await waiting; assert.equal((await f.setting({ loginCodeRequired: true })).status, 200); release();
  const response = await pending; assert.equal(response.status, 409); assert.equal(response.headers.get('set-cookie'), null);
});

test('unverified registration remains unverified after restart and phone-only identity handoff', async t => {
  const f = await fixture(t); await f.setting({ invitationRequired: false, registrationCodeRequired: false, registrationCaptchaRequired: false });
  const input = { phone: '+8613600136000', password, name: '测试' };
  const created = await f.request('/api/auth/register', input); assert.equal(created.status, 201);
  const before = (await created.json()).user; assert.deepEqual(before.unverifiedContacts, ['phone']);
  await f.restart(); const response = await f.request('/api/auth/login', input); assert.equal(response.status, 200);
  const user = (await response.json()).user; assert.deepEqual(user.unverifiedContacts, ['phone']); assert.equal(user.id, before.id);
  const { syncHubIdentity, accountProfile } = await import('../accounts.mjs'); syncHubIdentity(f.db, user);
  assert.deepEqual(accountProfile(f.db, user.id).unverifiedContacts, ['phone']);
  assert.equal(f.db.prepare('SELECT verified FROM user_phones WHERE user_id=?').get(user.id).verified, 0);
});

test('verification delivery works without CAPTCHA keys when CAPTCHA is disabled, while unavailable login factors cannot be enabled', async t => {
  const f = await fixture(t, { email: { ready: false, deliveryReady: true, captchaReady: false }, phone: { ready: false, deliveryReady: false, captchaReady: false }, captcha: { ready: false } });
  assert.equal((await f.setting({ invitationRequired: false, registrationCaptchaRequired: false })).status, 200);
  assert.equal((await f.setting({ loginCaptchaRequired: true })).status, 400);
  assert.equal((await f.request('/api/auth/email-code', { email: 'without-captcha@example.test' })).status, 200);
  assert.equal(f.captchaCalls.length, 0);
  f.seed('phone', '+8613700137000');
  assert.equal((await f.setting({ loginCodeRequired: true })).status, 400, 'enabling OTP must not lock out an existing unavailable contact channel');
  const config = await (await f.request('/api/config')).json(); assert.equal(config.registrationReady, true); assert.equal(config.captchaReady, false);
});

test('the standalone CAPTCHA provider binds hostname and action and never exposes its secret', async () => {
  let result = { success: true, hostname: 'hub.example', action: 'login_email' };
  const captcha = createCaptchaProvider({ TURNSTILE_SITE_KEY: 'public-site', TURNSTILE_SECRET_KEY: 'private-secret' }, async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return Response.json(result);
  });
  assert.equal(await captcha.verify('token', '127.0.0.1', 'hub.example', 'login_email'), true);
  result = { ...result, action: 'register_email' }; assert.equal(await captcha.verify('token', '', 'hub.example', 'login_email'), false);
  result = { ...result, action: 'login_email', hostname: 'other.example' }; assert.equal(await captcha.verify('token', '', 'hub.example', 'login_email'), false);
  assert.equal(JSON.stringify(captcha).includes('private-secret'), false);
});

test('server-side recovery disables only the optional login factors and requires an existing administrator', async t => {
  const f = await fixture(t); await f.setting({ loginCodeRequired: true, loginCaptchaRequired: true, invitationRequired: false });
  const before = await f.policy(), script = fileURLToPath(new URL('../scripts/admin.mjs', import.meta.url)), env = { ...process.env, DATA_DIR: f.directory };
  assert.throws(() => execFileSync(process.execPath, [script, 'auth-login-recovery', 'ordinary@example.test'], { env, stdio: 'pipe' }));
  assert.deepEqual(await f.policy(), before);
  execFileSync(process.execPath, [script, 'auth-login-recovery', 'admin@example.test'], { env, stdio: 'pipe' });
  const after = await f.policy(); assert.equal(after.loginCodeRequired, false); assert.equal(after.loginCaptchaRequired, false);
  for (const field of ['registrationCodeRequired', 'registrationCaptchaRequired', 'invitationRequired']) assert.equal(after[field], before[field]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='authentication-login-recovery'").get().n, 1);
});

test('a temporary sign-up bonus gives each new account free AI balance once, with a ledger entry, and stops at 0', async t => {
  const f = await fixture(t); await f.setting({ invitationRequired: false, registrationCodeRequired: false, registrationCaptchaRequired: false });
  const balance = id => f.db.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(id)?.balance ?? 0;
  f.db.prepare('UPDATE ai_signup_bonus SET amount=10000 WHERE id=1').run();
  const first = await f.request('/api/auth/register', { phone: '+8613600136001', password, name: '赠送' }); assert.equal(first.status, 201);
  const id = (await first.json()).user.id;
  assert.equal(balance(id), 10000);
  assert.deepEqual(f.db.prepare('SELECT delta,kind FROM ai_points_ledger WHERE user_id=?').all(id).map(row => ({ ...row })), [{ delta: 10000, kind: 'signup' }]);
  assert.equal((await f.request('/api/auth/register', { phone: '+8613600136001', password, name: '重复' })).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_points_ledger').get().n, 1);
  f.db.prepare('UPDATE ai_signup_bonus SET amount=0 WHERE id=1').run();
  const second = await f.request('/api/auth/register', { phone: '+8613600136002', password, name: '不赠送' });
  assert.equal(balance((await second.json()).user.id), 0);
  assert.equal(balance(f.actors.admin.id), 0);
});
