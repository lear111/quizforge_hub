import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { hubAccount, hubRedeem, hubComplete, officialFailure } from '../cloud/hub-ai.mjs';

const relay = responses => {
  const calls = [];
  return { calls, manageUrl: 'https://hub.example/manage/', async call(req, name, body) { calls.push({ name, body }); return responses[name]; } };
};
const request = body => Readable.from([Buffer.from(JSON.stringify(body))]);

test('cloud practice reads the signed-in account and its balance, and redeems straight to it', async () => {
  const hub = relay({ me: { status: 200, body: { user: { name: 'alice', email: 'a@example.test' }, ai: { enabled: true, balance: 32000 } } }, redeem: { status: 200, body: { added: 10000, balance: 42000 } } });
  assert.deepEqual(await hubAccount(hub, {}), { connected: true, user: { name: 'alice', email: 'a@example.test' }, ai: { enabled: true, balance: 32000 }, manageUrl: 'https://hub.example/manage/' });
  assert.deepEqual(await hubRedeem(hub, {}, 'AI-AAAA'), { added: 10000, balance: 42000 });
  assert.deepEqual(await hubAccount(relay({ me: { status: 401, body: null } }), {}), { connected: false, expired: true });
  assert.equal((await hubAccount(relay({ me: { status: 0, body: null } }), {})).unavailable, true);
  await assert.rejects(hubRedeem(relay({ redeem: { status: 400, body: { error: { code: 'REDEEM_CODE_INVALID', message: '兑换码无效' } } } }), {}, 'x'), { code: 'REDEEM_CODE_INVALID', message: '兑换码无效' });
});

test('free AI grading goes through the Hub as quizforge-official and maps failures to the Web fallback codes', async () => {
  const hub = relay({ 'chat/completions': { status: 200, body: { id: 'qf-1', choices: [{ message: { content: '{"score":1,"feedback":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, quizforge: { cost: 1, balance: 41999 } } } });
  const input = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], max_tokens: 8192, response_format: { type: 'json_object' } };
  const graded = await hubComplete(hub, request(input));
  assert.deepEqual(hub.calls[0].body, { model: 'quizforge-official', stream: false, ...input });
  assert.equal(graded.result.provider, 'quizforge-official'); assert.equal(graded.result.output, '{"score":1,"feedback":"ok"}'); assert.equal(graded.balance, 41999);
  await assert.rejects(hubComplete(hub, request({ ...input, model: 'other' })), { code: 'INVALID_AI_REQUEST' });
  await assert.rejects(hubComplete(relay({ 'chat/completions': { status: 200, body: { choices: [{ message: { content: '' } }] } } }), request(input)), { code: 'AI_OUTPUT_INVALID' });
  const code = (status, body = null, timeout = false) => officialFailure({ status, body, timeout }).code;
  assert.equal(code(401), 'AI_OFFICIAL_LOGIN'); assert.equal(code(402, { error: { code: 'AI_BALANCE_EXHAUSTED' } }), 'AI_OFFICIAL_BALANCE');
  assert.equal(code(429, { error: { code: 'AI_BUSY' } }), 'AI_RATE_LIMIT'); assert.equal(code(502), 'AI_UPSTREAM'); assert.equal(code(404), 'AI_OFFICIAL_UNAVAILABLE');
  assert.equal(code(0, null, true), 'AI_TIMEOUT'); assert.equal(code(0), 'AI_NETWORK'); assert.equal(code(413), 'AI_INPUT_LIMIT'); assert.equal(code(400), 'AI_CONFIG');
});
