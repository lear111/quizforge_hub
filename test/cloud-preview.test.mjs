import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('隔离预览只使用合成身份，能切换权限，拒绝跨站修改，不暴露内部会话', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qfh-preview-test-'));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/cloud-preview.mjs', import.meta.url))], {
    env: { ...process.env, PREVIEW_SYNTHETIC_DATA: '1', DATA_DIR: path.join(directory, 'quizforge-hub-cloud-test'), PREVIEW_PORT: String(port), PREVIEW_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview startup timeout')), 10000);
    child.stdout.on('data', data => { if (data.toString().includes('Isolated cloud preview ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Preview exited before ready')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const admin = await (await fetch(origin + '/api/me')).json(); assert.equal(admin.user.admin, 1); assert.match(admin.user.email, /example\.test$/);
  const page = await fetch(origin + '/cloud/ai'); assert.match(await page.text(), /仅含合成数据/); assert.equal(page.headers.get('set-cookie'), null);
  const change = (site, role) => fetch(origin + '/__preview/identity', { method: 'POST', headers: { Origin: site, 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  assert.equal((await change('https://evil.example', 'reader')).status, 403);
  const reader = await change(origin, 'reader'); assert.equal(reader.status, 200);
  const cookie = reader.headers.get('set-cookie').split(';')[0]; assert.equal(cookie, 'qfh_preview_role=reader');
  const request = route => fetch(origin + route, { headers: { Cookie: cookie } });
  assert.equal((await request('/api/cloud/admin/users')).status, 403);
  assert.equal((await (await request('/api/me')).json()).user.admin, 0);
  assert.equal((await request('/api/cloud/me')).status, 200);
  assert.equal((await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Origin: origin } })).status, 403);
  assert.equal((await change(origin, 'unknown')).status, 400);
});
