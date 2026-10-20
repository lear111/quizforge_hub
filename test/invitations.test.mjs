import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createInvitations } from '../invitations.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-invites-')), codes = new Map();
  const provider = { ready: true, pepper: 'synthetic-invitation-test-pepper'.repeat(3), verify: async () => true, send: async (email, code) => codes.set(email, code) };
  let server, origin;
  const start = async () => {
    ({ server } = await createApp({ dataDir, mailProvider: provider, invitationRequired: true, practiceOrigin: 'https://practice.example' }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite')), admin = randomUUID(), ordinary = randomUUID();
  for (const [id, role] of [[admin, 1], [ordinary, 0]]) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, id + '@example.test', '合成账号', 'not-login', role, new Date().toISOString());
  const invitations = createInvitations(db);
  t.after(async () => { await stop(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (route, body) => fetch(origin + route, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const account = email => ({ email, name: '测试', password: 'synthetic-password-only' });
  const challenge = (email, invitationCode) => request('/api/auth/email-code', { email, invitationCode, captchaToken: 'synthetic' });
  const register = (email, invitationCode, code = codes.get(email)) => request('/api/auth/register', { ...account(email), invitationCode, code });
  return { dataDir, db, invitations, admin, ordinary, request, account, challenge, register, codes, restart: async () => { await stop(); await start(); } };
}

test('invitation gates mail and registration, failed verification preserves it; one redemption survives restart and login needs no invitation', async t => {
  const f = await fixture(t), email = 'alice@example.test', [{ code, id }] = f.invitations.create(f.admin);
  const config = await (await f.request('/api/config')).json(); assert.equal(config.invitationRequired, true); assert.equal(config.practiceOrigin, 'https://practice.example');
  assert.equal((await f.challenge(email)).status, 400); assert.equal(f.codes.size, 0);
  assert.equal((await f.register(email)).status, 400);
  assert.equal((await f.challenge(email, code.toLowerCase())).status, 200);
  const real = f.codes.get(email), wrong = real === '000000' ? '111111' : '000000';
  assert.equal((await f.register(email, code, wrong)).status, 400); assert.equal(f.invitations.list(f.admin).find(row => row.id === id).state, 'available');
  const response = await f.register(email, code); assert.equal(response.status, 201); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  const user = (await response.json()).user; assert.equal(f.invitations.list(f.admin).find(row => row.id === id).user_id, user.id);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM invitations').all()).includes(code), false);
  assert.equal((await f.challenge('other@example.test', code)).status, 400);
  await f.restart(); assert.equal((await f.register('other@example.test', code)).status, 400);
  assert.equal((await f.request('/api/auth/login', f.account(email))).status, 200);
});

test('two accounts racing one invitation create exactly one account and never consume the loser email code', async t => {
  const f = await fixture(t), [{ code }] = f.invitations.create(f.admin), emails = ['one@example.test', 'two@example.test'];
  for (const email of emails) assert.equal((await f.challenge(email, code)).status, 200);
  const responses = await Promise.all(emails.map(email => f.register(email, code)));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email IN (?,?)").get(...emails).n, 1);
  const loser = emails[responses.findIndex(r => r.status === 400)], [{ code: another }] = f.invitations.create(f.admin);
  assert.equal((await f.register(loser, another)).status, 201);
});

test('admin creates/lists/revokes invitations; ordinary accounts cannot manage and expired/revoked codes cannot register', async t => {
  const f = await fixture(t), [{ id, code }] = f.invitations.create(f.admin);
  assert.throws(() => f.invitations.create(f.ordinary), /管理员/); assert.throws(() => f.invitations.list(f.ordinary), /管理员/);
  assert.throws(() => f.invitations.revoke(f.ordinary, id), /管理员/);
  f.invitations.revoke(f.admin, id); assert.equal((await f.challenge('alice@example.test', code)).status, 400);
  await f.restart(); assert.equal(f.invitations.list(f.admin).find(row => row.id === id).state, 'revoked');
  const [{ code: expired, id: expiredId }] = f.invitations.create(f.admin); f.db.prepare('UPDATE invitations SET expires=0 WHERE id=?').run(expiredId);
  assert.equal((await f.challenge('alice@example.test', expired)).status, 400);
  const script = fileURLToPath(new URL('../scripts/admin.mjs', import.meta.url)), env = { ...process.env, DATA_DIR: f.dataDir };
  const issued = JSON.parse(execFileSync(process.execPath, [script, 'invite-create', f.admin + '@example.test', '2', '7'], { env, encoding: 'utf8' })); assert.equal(issued.length, 2);
  const list = JSON.parse(execFileSync(process.execPath, [script, 'invite-list', f.admin + '@example.test'], { env, encoding: 'utf8' })); assert.equal(list.some(row => row.id === issued[0].id && row.state === 'available'), true); assert.equal(JSON.stringify(list).includes(issued[0].code), false);
  execFileSync(process.execPath, [script, 'invite-revoke', f.admin + '@example.test', issued[0].id], { env });
  assert.throws(() => f.invitations.check(issued[0].code), /邀请码/);
});
