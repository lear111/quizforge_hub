import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptKey, decryptKey, connection, setSession, session, clearSessions, testConnection } from '../public/cloud/vault.js';

test('本地密文绑定账户、站点和模型地址，口令不保存，篡改与错误口令拒绝解锁', async () => {
  const bound = { account: 'alice', origin: 'https://hub.example.test', endpoint: 'https://model.example.test/v1' };
  const secret = 'synthetic-api-key', password = 'synthetic-unlock-passphrase';
  const encrypted = await encryptKey(secret, password, bound);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.equal(JSON.stringify(encrypted).includes(password), false);
  assert.equal(await decryptKey(encrypted, password, bound), secret);
  for (const change of [{ account: 'bob' }, { origin: 'https://other.example.test' }, { endpoint: 'https://other-model.example.test/v1' }]) await assert.rejects(decryptKey(encrypted, password, { ...bound, ...change }), /解锁失败/);
  await assert.rejects(decryptKey(encrypted, 'wrong-password', bound), /解锁失败/);
  await assert.rejects(decryptKey({ ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + 'AAAA' }, password, bound), /解锁失败/);
  const second = await encryptKey(secret, password, bound);
  assert.notEqual(second.iv, encrypted.iv); assert.notEqual(second.salt, encrypted.salt);
});
test('Key 只进入选定模型的认证头，禁止 HTTP 和重定向，不显示供应商原始返回', async () => {
  const profile = { baseUrl: 'https://model.example.test/v1/', model: 'synthetic-model', apiKey: 'synthetic-secret' };
  assert.throws(() => connection({ ...profile, baseUrl: 'http://model.example.test/v1' }), /HTTPS/);
  assert.throws(() => connection({ ...profile, baseUrl: 'https://user:password@model.example.test' }), /HTTPS/);
  const calls = [];
  const value = await testConnection(profile, async (url, options) => { calls.push({ url, options }); return new Response('provider-echo-synthetic-secret'); });
  assert.deepEqual(value, { ok: true }); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://model.example.test/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-secret');
  assert.equal(calls[0].options.body.includes(profile.apiKey), false);
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(testConnection(profile, async () => new Response('sensitive upstream text', { status: 401 })), /认证失败/);
  setSession('alice', profile); assert.equal(session('bob'), null); assert.equal(session('alice').apiKey, profile.apiKey);
  clearSessions(); assert.equal(session('alice'), null);
});
