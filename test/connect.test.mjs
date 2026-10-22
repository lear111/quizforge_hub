import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { authorizeParams, allowedRedirect } from '../connect.mjs';
import { shanghaiDay, nextShanghaiMidnight, validateCompletion, pointsFor } from '../official-ai.mjs';
import { createAiPoints, normalizeCode } from '../ai-points.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const challengeOf = verifier => createHash('sha256').update(verifier).digest('base64url');
const settings = (extra = {}) => ({ enabled: true, baseUrl: 'https://upstream.example/v1', model: 'qwen-vl-plus', key: 'synthetic-upstream-key', tokensPerPoint: 100, monthlyTokens: 1000, ...extra });
// Tests add points directly; real accounts only get them from redeem codes.
const grant = (f, user, points) => f.db.prepare('INSERT INTO ai_points VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance').run(f.users[user].id, points, Date.now());

async function fixture(t, { officialAi = settings(), upstream } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qfh-connect-'));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return upstream ? upstream(calls.at(-1)) : new Response(JSON.stringify({ id: 'upstream-id', choices: [{ index: 0, message: { role: 'assistant', content: '{"score":1}' } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }), { status: 200 }); };
  const app = await createApp({ dataDir, mailProvider: { ready: false }, officialAi, officialAiFetch: fetchImpl });
  const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'));
  const users = {};
  for (const name of ['alice', 'bob']) {
    const id = randomUUID(), cookie = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, `${name}@example.test`, name, 'not-a-login-password', 0, new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(cookie), id, Date.now() + 3600000);
    users[name] = { id, cookie: 'qfh_session=' + cookie };
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (pathname, { method = 'GET', body, user, headers = {}, origin: from = origin } = {}) => fetch(origin + pathname, { method, redirect: 'manual', headers: { ...(user ? { Cookie: users[user].cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && from ? { Origin: from } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { app, db, users, request, calls, origin };
}

function authorizeQuery({ client = 'web', redirectUri = 'http://127.0.0.1:8787/hub/connect/callback', state = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url'), name = '书房电脑' } = {}) {
  const query = new URLSearchParams({ v: '1', client, redirect_uri: redirectUri, state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', device_name: name });
  return { query: query.toString(), state, verifier, client, redirectUri };
}

// Walks the whole browser flow and returns the device token.
async function connectDevice(f, user = 'alice', options = {}) {
  const flow = authorizeQuery(options);
  const page = await f.request('/connect/authorize?' + flow.query, { user });
  assert.equal(page.status, 200);
  const request = /data-request="([a-f0-9]{64})"/.exec(await page.text())[1];
  const decision = await (await f.request('/api/connect/authorize', { method: 'POST', user, body: { request, decision: 'allow' } })).json();
  const back = new URL(decision.redirect);
  assert.equal(back.searchParams.get('state'), flow.state);
  const exchanged = await f.request('/api/connect/token', { method: 'POST', origin: null, body: { v: 1, client: flow.client, code: back.searchParams.get('code'), code_verifier: flow.verifier, redirect_uri: flow.redirectUri } });
  assert.equal(exchanged.status, 200);
  return { ...(await exchanged.json()), flow, code: back.searchParams.get('code') };
}
const bearer = token => ({ Authorization: 'Bearer ' + token });
const completion = (extra = {}) => ({ model: 'quizforge-official', messages: [{ role: 'system', content: '评分' }, { role: 'user', content: [{ type: 'text', text: '答案' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }], response_format: { type: 'json_object' }, ...extra });

test('authorize parameters accept only the documented redirects and PKCE values', () => {
  assert.ok(allowedRedirect('web', 'http://127.0.0.1:8787/hub/connect/callback'));
  assert.ok(allowedRedirect('web', 'http://localhost:65535/hub/connect/callback'));
  assert.ok(allowedRedirect('android', 'quizforge://hub/connect'));
  for (const [client, uri] of [['web', 'http://127.0.0.1:80/hub/connect/callback'], ['web', 'http://192.168.1.2:8787/hub/connect/callback'], ['web', 'https://127.0.0.1:8787/hub/connect/callback'], ['web', 'http://127.0.0.1:8787/hub/connect/callback?x=1'], ['web', 'quizforge://hub/connect'], ['android', 'quizforge://hub/connect/'], ['android', 'http://127.0.0.1:8787/hub/connect/callback']]) assert.equal(allowedRedirect(client, uri), false, uri);
  assert.ok(authorizeParams(new URLSearchParams(authorizeQuery().query)));
  const bad = query => authorizeParams(new URLSearchParams(query));
  const good = new URLSearchParams(authorizeQuery().query);
  for (const [key, value] of [['v', '2'], ['code_challenge_method', 'plain'], ['code_challenge', 'short'], ['state', 'too-short'], ['device_name', ''], ['device_name', 'x'.repeat(41)]]) { const next = new URLSearchParams(good); next.set(key, value); assert.equal(bad(next), null, key); }
  const extra = new URLSearchParams(good); extra.append('scope', 'all'); assert.equal(bad(extra), null, 'unknown parameter');
  const twice = new URLSearchParams(good); twice.append('state', good.get('state')); assert.equal(bad(twice), null, 'repeated parameter');
});

test('a logged-out browser goes to login first, then a consent page; allowing issues a single-use code bound to PKCE', async t => {
  const f = await fixture(t);
  const flow = authorizeQuery({ name: '<script>书房</script>' });
  const anonymous = await f.request('/connect/authorize?' + flow.query);
  assert.equal(anonymous.status, 303);
  const request = /^\/manage\/#connect-login\/([a-f0-9]{64})$/.exec(anonymous.headers.get('location'))[1];
  const page = await f.request('/connect/authorize?request=' + request, { user: 'alice' });
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /&lt;script&gt;书房&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>书房/); assert.match(html, /当前剩余 0 点/);
  assert.equal((await f.request('/connect/authorize?v=1&client=web', { user: 'alice' })).status, 400);
  const noOrigin = await f.request('/api/connect/authorize', { method: 'POST', user: 'alice', origin: null, body: { request, decision: 'allow' } });
  assert.equal(noOrigin.status, 403, 'the consent decision keeps the same-origin check');
  const decision = await (await f.request('/api/connect/authorize', { method: 'POST', user: 'alice', body: { request, decision: 'allow' } })).json();
  const back = new URL(decision.redirect);
  assert.equal(back.origin + back.pathname, 'http://127.0.0.1:8787/hub/connect/callback'); assert.equal(back.searchParams.get('state'), flow.state);
  const code = back.searchParams.get('code');
  const exchange = verifier => f.request('/api/connect/token', { method: 'POST', origin: null, body: { v: 1, client: 'web', code, code_verifier: verifier, redirect_uri: flow.redirectUri } });
  const wrong = await exchange(randomBytes(48).toString('base64url'));
  assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error.code, 'INVALID_GRANT');
  assert.equal((await exchange(flow.verifier)).status, 400, 'a failed attempt burns the code');
  assert.equal((await f.request('/api/connect/authorize', { method: 'POST', user: 'alice', body: { request, decision: 'allow' } })).status, 410, 'the consent request is single-use');
});

test('device tokens read their account and quota, and stop working after logout, revocation or a block', async t => {
  const f = await fixture(t);
  const first = await connectDevice(f);
  assert.match(first.token, /^qfd_[A-Za-z0-9_-]{43}$/); assert.equal(first.device.name, '书房电脑'); assert.equal(first.user.name, 'alice');
  assert.equal(f.db.prepare('SELECT token FROM connect_devices WHERE id=?').get(first.device.id).token, hash(first.token), 'only the token hash is stored');
  const me = await (await f.request('/api/connect/me', { headers: bearer(first.token) })).json();
  assert.deepEqual({ user: me.user.name, client: me.device.client, points: me.ai.points, tokensPerPoint: me.ai.tokensPerPoint, enabled: me.ai.enabled }, { user: 'alice', client: 'web', points: 0, tokensPerPoint: 100, enabled: true });
  const reused = await f.request('/api/connect/token', { method: 'POST', origin: null, body: { v: 1, client: 'web', code: first.code, code_verifier: first.flow.verifier, redirect_uri: first.flow.redirectUri } });
  assert.equal(reused.status, 400, 'codes are single-use');
  assert.equal((await f.request('/api/connect/me', { headers: { Cookie: f.users.alice.cookie } })).status, 401, 'a browser session is not a device token');
  const list = await (await f.request('/api/connect/devices', { user: 'alice' })).json();
  assert.deepEqual(list.devices.map(d => d.id), [first.device.id]);
  assert.deepEqual((await (await f.request('/api/connect/devices', { user: 'bob' })).json()).devices, [], 'devices are per account');
  assert.equal((await f.request('/api/connect/devices/' + first.device.id, { method: 'DELETE', user: 'bob' })).status, 404, 'others cannot revoke');
  assert.equal((await f.request('/api/connect/devices/' + first.device.id, { method: 'PUT', user: 'alice', body: { name: '客厅电脑' } })).status, 200);
  assert.equal((await (await f.request('/api/connect/me', { headers: bearer(first.token) })).json()).device.name, '客厅电脑');
  assert.equal((await f.request('/api/connect/devices/' + first.device.id, { method: 'DELETE', user: 'alice' })).status, 200);
  const revoked = await f.request('/api/connect/me', { headers: bearer(first.token) });
  assert.equal(revoked.status, 401); assert.equal((await revoked.json()).error.code, 'DEVICE_TOKEN_INVALID');
  const second = await connectDevice(f, 'alice', { client: 'android', redirectUri: 'quizforge://hub/connect', name: 'Pixel Tablet' });
  assert.equal((await f.request('/api/connect/logout', { method: 'POST', origin: null, headers: bearer(second.token) })).status, 204);
  assert.equal((await f.request('/api/connect/me', { headers: bearer(second.token) })).status, 401);
  const third = await connectDevice(f, 'bob');
  f.db.prepare('INSERT INTO user_blocks VALUES (?,?,?,?)').run(f.users.bob.id, f.users.alice.id, 'test', Date.now());
  assert.equal((await f.request('/api/connect/me', { headers: bearer(third.token) })).status, 401, 'a blocked account loses device access at once');
});

test('denying returns access_denied, and an account keeps at most ten devices', async t => {
  const f = await fixture(t);
  const flow = authorizeQuery({ client: 'android', redirectUri: 'quizforge://hub/connect' });
  const page = await (await f.request('/connect/authorize?' + flow.query, { user: 'alice' })).text();
  const request = /data-request="([a-f0-9]{64})"/.exec(page)[1];
  const denied = await (await f.request('/api/connect/authorize', { method: 'POST', user: 'alice', body: { request, decision: 'deny' } })).json();
  assert.equal(denied.redirect, `quizforge://hub/connect?error=access_denied&state=${flow.state}`);
  const tokens = [];
  for (let index = 0; index < 11; index++) tokens.push((await connectDevice(f, 'alice', { name: '设备' + index })).token);
  assert.equal((await (await f.request('/api/connect/devices', { user: 'alice' })).json()).devices.length, 10);
  assert.equal((await f.request('/api/connect/me', { headers: bearer(tokens.at(-1)) })).status, 200);
});

test('the gateway forces the model, spends points by tokens, charges nothing for upstream failures and stops at the monthly budget', async t => {
  let mode = 'ok';
  const f = await fixture(t, { upstream: () => mode === 'down' ? new Response('{"error":"boom"}', { status: 503 }) : new Response(JSON.stringify({ id: 'upstream-id', choices: [{ index: 0, message: { role: 'assistant', content: '{"score":1}' } }], usage: { total_tokens: 400 } }), { status: 200 }) });
  const { token } = await connectDevice(f);
  grant(f, 'alice', 10);
  const call = (body = completion(), headers = bearer(token)) => f.request('/api/ai/v1/chat/completions', { method: 'POST', origin: null, headers, body });
  const points = async () => (await (await f.request('/api/connect/me', { headers: bearer(token) })).json()).ai.points;
  const ok = await call();
  const result = await ok.json();
  assert.equal(ok.status, 200); assert.equal(result.model, 'quizforge-official'); assert.equal(result.choices[0].message.content, '{"score":1}'); assert.notEqual(result.id, 'upstream-id');
  assert.deepEqual(result.quizforge, { pointsSpent: 4, points: 6 }, '400 tokens at 100 per point');
  const sent = f.calls[0];
  assert.equal(sent.url, 'https://upstream.example/v1/chat/completions'); assert.equal(sent.init.headers.Authorization, 'Bearer synthetic-upstream-key'); assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.body.model, 'qwen-vl-plus'); assert.equal(sent.body.max_tokens, 8192); assert.deepEqual(sent.body.response_format, { type: 'json_object' });
  mode = 'down';
  const failed = await call();
  assert.equal(failed.status, 502); assert.equal((await failed.json()).error.code, 'AI_UPSTREAM_FAILED');
  assert.equal(await points(), 6, 'the failed call cost nothing');
  mode = 'ok';
  assert.equal((await call()).status, 200);
  assert.equal(await points(), 2);
  assert.equal((await call()).status, 200, 'at 800 of 1000 tokens the budget still admits a call');
  assert.equal(await points(), 0, 'a call that costs more than the balance stops at 0');
  const exhausted = await call();
  assert.equal(exhausted.status, 503); assert.equal((await exhausted.json()).error.code, 'AI_BUDGET_EXHAUSTED', 'once 1200 tokens are used the month stops');
  assert.equal((await (await f.request('/api/connect/me', { headers: bearer(token) })).json()).ai.enabled, false);
  const row = f.db.prepare('SELECT calls,tokens,points FROM official_ai_usage WHERE user_id=?').get(f.users.alice.id);
  assert.deepEqual({ ...row }, { calls: 3, tokens: 1200, points: 10 });
  const columns = f.db.prepare('PRAGMA table_info(official_ai_usage)').all().map(c => c.name);
  assert.deepEqual(columns, ['user_id', 'day', 'calls', 'tokens', 'points'], 'no request or answer content is stored');
});

test('an empty balance stops grading before the upstream, and malformed or oversized requests are rejected first', async t => {
  const f = await fixture(t, { officialAi: settings({ monthlyTokens: 1e9 }) });
  const { token } = await connectDevice(f);
  const call = (body, headers = bearer(token)) => f.request('/api/ai/v1/chat/completions', { method: 'POST', origin: null, headers, body });
  for (const [body, code] of [[completion({ model: 'gpt-4o' }), 'AI_REQUEST_UNSUPPORTED'], [completion({ stream: true }), 'AI_REQUEST_UNSUPPORTED'], [completion({ tools: [] }), 'AI_REQUEST_UNSUPPORTED'], [completion({ max_tokens: 9000 }), 'AI_REQUEST_UNSUPPORTED'], [{ ...completion(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }] }, 'AI_REQUEST_UNSUPPORTED'], [{ ...completion(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024) } }] }] }, 'AI_REQUEST_TOO_LARGE']]) {
    const response = await call(body);
    assert.equal((await response.json()).error.code, code, JSON.stringify(Object.keys(body)));
  }
  assert.equal((await call(completion(), {})).status, 401);
  assert.equal((await call(completion(), bearer('qfd_' + 'x'.repeat(43)))).status, 401);
  assert.equal(f.calls.length, 0, 'nothing invalid reached the upstream');
  const empty = await call(completion());
  assert.equal(empty.status, 402); assert.equal((await empty.json()).error.code, 'AI_POINTS_EXHAUSTED');
  assert.equal(f.calls.length, 0, 'a new account has no points and nothing reaches the upstream');
  grant(f, 'alice', 1);
  assert.equal((await call(completion())).status, 200);
  assert.equal((await call(completion())).status, 402, 'the single point was spent');
  assert.equal(pointsFor(0, 1000), 1); assert.equal(pointsFor(1001, 1000), 2); assert.equal(pointsFor(1000, 1000), 1);
});

test('redeem codes add points once, are stored as hashes and lock out guessing', async t => {
  const f = await fixture(t);
  const points = createAiPoints({ db: f.db });
  const [first, second] = points.createCodes(f.users.bob.id, { count: 2, points: 50, days: 30, note: '内测' });
  assert.match(first.code, /^AI-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM ai_redeem_codes').all());
  assert.equal(stored.includes(first.code.slice(3).replaceAll('-', '')), false, 'only the hash is stored');
  assert.equal(normalizeCode(' ' + first.code.toLowerCase().replaceAll('-', ' ') + ' '), first.code.slice(3).replaceAll('-', ''), 'case, spaces and dashes do not matter');
  const { token } = await connectDevice(f);
  const redeem = code => f.request('/api/connect/redeem', { method: 'POST', origin: null, headers: bearer(token), body: { code } });
  const ok = await redeem(first.code);
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { added: 50, points: 50 });
  const again = await redeem(first.code);
  assert.equal(again.status, 400); assert.equal((await again.json()).error.code, 'REDEEM_CODE_INVALID', 'a code works once');
  assert.equal((await (await f.request('/api/connect/me', { headers: bearer(token) })).json()).ai.points, 50);
  assert.equal(points.revokeCode(second.id).id, second.id);
  assert.equal((await redeem(second.code)).status, 400, 'a revoked code cannot be redeemed');
  assert.throws(() => points.revokeCode(first.id), { code: 'AI_CODE_REDEEMED' });
  assert.equal((await f.request('/api/connect/redeem', { method: 'POST', origin: null, user: 'alice', body: { code: second.code } })).status, 401, 'a browser session cannot redeem for a device');
  // Ten wrong codes in an hour lock the account out of redeeming, even with a valid code.
  const locker = createAiPoints({ db: f.db });
  for (let i = 0; i < 10; i++) assert.throws(() => locker.redeem(f.users.alice.id, 'AI-0000-0000-0000-000' + i), { code: 'REDEEM_CODE_INVALID' });
  const [third] = locker.createCodes(f.users.bob.id, { count: 1, points: 5, days: 1 });
  assert.throws(() => locker.redeem(f.users.alice.id, third.code), { code: 'REDEEM_LOCKED' });
  assert.equal(locker.balance(f.users.alice.id), 50);
  const ledger = f.db.prepare('SELECT delta,kind FROM ai_points_ledger WHERE user_id=?').all(f.users.alice.id).map(row => ({ ...row }));
  assert.deepEqual(ledger, [{ delta: 50, kind: 'redeem' }]);
});

test('turning the feature off hides every endpoint, and Shanghai days reset at local midnight', async t => {
  const f = await fixture(t, { officialAi: settings({ enabled: false }) });
  assert.deepEqual((await (await f.request('/api/config')).json()).officialAi, { enabled: false, protocolVersion: 1 });
  for (const [pathname, method] of [['/connect/authorize?' + authorizeQuery().query, 'GET'], ['/api/connect/token', 'POST'], ['/api/connect/me', 'GET'], ['/api/ai/v1/chat/completions', 'POST']]) {
    const response = await f.request(pathname, { method, origin: null, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(response.status, 404, pathname);
  }
  assert.equal(shanghaiDay(Date.parse('2026-10-22T15:59:59Z')), '2026-10-22');
  assert.equal(shanghaiDay(Date.parse('2026-10-22T16:00:00Z')), '2026-10-23');
  assert.equal(nextShanghaiMidnight(Date.parse('2026-10-22T10:00:00Z')), '2026-10-23T00:00:00+08:00');
  assert.throws(() => validateCompletion({ model: 'quizforge-official', messages: [{ role: 'tool', content: 'x' }] }), /消息格式/);
});
