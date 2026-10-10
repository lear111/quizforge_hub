import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7u0AAAAASUVORK5CYII=', 'base64');
async function start(dataDir, monthlyBudgetBytes) {
  const codes = new Map();
  const mailProvider = { ready: true, pepper: 'test-only-pepper'.repeat(3), verify: async () => true, send: async (email, code) => codes.set(email, code) };
  const { server } = await createApp({ dataDir, monthlyBudgetBytes, mailProvider });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { cookie, ...options } = {}) => fetch(origin + route, { ...options, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
  const close = () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  return { request, close, origin, codes };
}
const json = (body, cookie, method = 'POST') => ({ method, cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function register(app, email, name = '作者') {
  assert.equal((await app.request('/api/auth/email-code', json({ email, captchaToken: 'test' }))).status, 200);
  const res = await app.request('/api/auth/register', json({ name, email, password: ' safe-password ', code: app.codes.get(email) }));
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(res.headers.get('set-cookie'), /SameSite=Lax/);
  return { cookie, user: (await res.json()).user };
}
function uploadForm({ title = '离散数学练习', archive = zip, screenshot = true, keep = [] } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title, summary: '用于测试的题库', description: '第一章\n第二章', version: '1.0', tags: '数学, 离散数学', rights: 'yes', keepScreenshots: JSON.stringify(keep) })) form.set(key, value);
  if (archive) form.set('archive', new Blob([archive]), 'questions.zip');
  if (screenshot) form.append('screenshots', new Blob([png], { type: 'image/png' }), 'preview.png');
  return form;
}

test('真实上传下载、作者权限、评论举报、修改和重启恢复', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quizforge-hub-test-'));
  let app = await start(dataDir);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const alice = await register(app, 'alice@example.test');
  const bob = await register(app, 'bob@example.test', '读者');
  let pack;
  await t.test('匿名可浏览，必须登录才能上传', async () => {
    assert.equal((await app.request('/')).status, 200);
    assert.equal((await app.request('/api/packs')).status, 200);
    assert.equal((await app.request('/api/packs', { method: 'POST', body: uploadForm() })).status, 401);
  });
  await t.test('跨站请求和伪装 ZIP 均被拒绝', async () => {
    assert.equal((await app.request('/api/packs', { method: 'POST', cookie: alice.cookie, body: uploadForm(), headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await app.request('/api/packs', { method: 'POST', cookie: alice.cookie, body: uploadForm({ archive: Buffer.from('<script>evil</script>') }) })).status, 400);
  });
  await t.test('压缩包、截图、校验值和信息正确保存', async () => {
    const res = await app.request('/api/packs', { method: 'POST', cookie: alice.cookie, body: uploadForm() });
    assert.equal(res.status, 201); pack = (await res.json()).pack;
    assert.equal(pack.user_id, alice.user.id); assert.equal(pack.screenshots.length, 1);
    assert.equal(pack.archive.size, zip.length); assert.equal(pack.archive.sha256.length, 64);
    assert.deepEqual(Buffer.from(await (await app.request(`/api/packs/${pack.id}/download`)).arrayBuffer()), zip);
    assert.deepEqual(Buffer.from(await (await app.request(`/media/${pack.screenshots[0].id}`)).arrayBuffer()), png);
    const list = await (await app.request('/api/packs?q=离散')).json();
    assert.equal(list.count, 1); assert.equal(list.packs[0].downloads, 1);
    assert.equal(JSON.stringify(list).includes('alice@example'), false);
  });
  await t.test('其他账号不能编辑、删除或删除他人评论', async () => {
    assert.equal((await app.request(`/api/packs/${pack.id}`, { method: 'PUT', cookie: bob.cookie, body: uploadForm() })).status, 403);
    assert.equal((await app.request(`/api/packs/${pack.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 403);
    const res = await app.request(`/api/packs/${pack.id}/comments`, json({ body: '<img src=x onerror=alert(1)> 有帮助，谢谢' }, bob.cookie));
    assert.equal(res.status, 201); const comment = (await res.json()).comment;
    assert.equal((await app.request(`/api/comments/${comment.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 403);
    assert.equal((await app.request(`/api/packs/${pack.id}/comments`, json({ body: '匿名评论' }))).status, 401);
    assert.equal((await app.request(`/api/packs/${pack.id}/report`, json({ reason: '用于测试举报流程' }, bob.cookie))).status, 201);
    assert.equal((await app.request('/api/reports', { cookie: bob.cookie })).status, 403);
  });
  await t.test('作者修改介绍并保留已有文件，未知截图不能关联', async () => {
    const invalid = uploadForm({ archive: null, screenshot: false, keep: ['00000000-0000-0000-0000-000000000000'] });
    assert.equal((await app.request(`/api/packs/${pack.id}`, { method: 'PUT', cookie: alice.cookie, body: invalid })).status, 400);
    const form = uploadForm({ title: '离散数学 · 第二版', archive: null, screenshot: false, keep: [pack.screenshots[0].id] });
    const res = await app.request(`/api/packs/${pack.id}`, { method: 'PUT', cookie: alice.cookie, body: form });
    assert.equal(res.status, 200); const changed = (await res.json()).pack;
    assert.equal(changed.archive.id, pack.archive.id); assert.equal(changed.screenshots[0].id, pack.screenshots[0].id);
    assert.equal(changed.title, '离散数学 · 第二版');
  });
  await t.test('重启后账号、会话、文件和评论仍存在', async () => {
    await app.close(); app = await start(dataDir);
    assert.equal((await (await app.request('/api/me', { cookie: alice.cookie })).json()).user.id, alice.user.id);
    const detail = await (await app.request(`/api/packs/${pack.id}`)).json();
    assert.equal(detail.comments.length, 1); assert.equal(detail.pack.title, '离散数学 · 第二版');
    assert.deepEqual(Buffer.from(await (await app.request(`/api/packs/${pack.id}/download`)).arrayBuffer()), zip);
    const login = await app.request('/api/auth/login', json({ email: 'alice@example.test', password: ' safe-password ' }));
    assert.equal(login.status, 200);
    const mine = await (await app.request('/api/packs?mine=1', { cookie: bob.cookie })).json(); assert.equal(mine.count, 0);
  });
  await t.test('退出使会话失效，下架清除相关记录和文件', async () => {
    assert.equal((await app.request('/api/auth/logout', { method: 'POST', cookie: bob.cookie })).status, 200);
    assert.equal((await (await app.request('/api/me', { cookie: bob.cookie })).json()).user, null);
    assert.equal((await app.request(`/api/packs/${pack.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 200);
    assert.equal((await app.request(`/api/packs/${pack.id}`)).status, 404);
    assert.equal((await app.request(`/media/${pack.screenshots[0].id}`)).status, 404);
    assert.equal((await app.request('/data/hub.sqlite')).status, 404);
  });
});

test('附件下载预算是持久化硬限制，重启不重置', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quizforge-budget-test-'));
  let app = await start(dataDir, zip.length * 2);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const author = await register(app, 'budget@example.test');
  const res = await app.request('/api/packs', { method: 'POST', cookie: author.cookie, body: uploadForm({ screenshot: false }) });
  const { pack } = await res.json(); const route = `/api/packs/${pack.id}/download`;
  assert.equal((await app.request(`/api/packs/${pack.id}/download-status`)).status, 200);
  for (let i = 0; i < 2; i++) { const res = await app.request(route); assert.equal(res.status, 200); await res.arrayBuffer(); }
  assert.equal((await app.request(route)).status, 429);
  assert.equal((await app.request(`/api/packs/${pack.id}/download-status`)).status, 429);
  await app.close(); app = await start(dataDir, zip.length * 2);
  assert.equal((await app.request(route)).status, 429);
  assert.equal((await app.request('/api/packs')).status, 200);
});
