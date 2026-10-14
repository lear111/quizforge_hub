// Isolated, synthetic UI fixture. Never uses the ordinary data/ directory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { DatabaseSync } from 'node:sqlite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.sites-runtime', 'browser-qa');
const codes = new Map();
const mailProvider = { ready: true, pepper: 'isolated-browser-fixture-pepper'.repeat(3),
  siteKey: '1x00000000000000000000AA', verify: async () => true,
  send: async (email, code) => { codes.set(email, code); } };
const { server } = await createApp({ dataDir, mailProvider });
await new Promise(resolve => server.listen(4319, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:4319';
const account = { email: 'local.qa@example.test', password: 'local-ui-test-only', name: '界面验收账号' };
const json = body => ({ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let response = await fetch(origin + '/api/auth/login', json(account));
if (!response.ok) {
  const challenge = await fetch(origin + '/api/auth/email-code', json({ email: account.email, captchaToken: 'isolated-ui-token' }));
  if (!challenge.ok) throw new Error('Cannot create isolated email challenge');
  response = await fetch(origin + '/api/auth/register', json({ ...account, code: codes.get(account.email) }));
}
if (!response.ok) throw new Error('Cannot create isolated UI fixture');
const cookie = response.headers.get('set-cookie').split(';')[0];
const db = new DatabaseSync(path.join(dataDir,'hub.sqlite'));
db.prepare('UPDATE users SET admin=1 WHERE email=?').run(account.email); db.close();
const existing = await (await fetch(origin + '/api/packs?mine=1',{headers:{Cookie:cookie}})).json();
if (!existing.count) {
  const data = new FormData();
  const fields = { title: '界面验收样例 · 离散数学基础练习', summary: '用于验证题库展示、上传编辑、下载和评论交互，不是正式题库。', description: '这是专用测试环境中的界面验收样例。\n\n演示范围：集合与关系、图论、命题逻辑。\n附件为测试用空 ZIP，不含真实题目，请勿作为学习资料使用。', category: '大学课程', version: '1.0', tags: '离散数学, 界面验收, 非正式资料', rights: 'yes' };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  data.set('archive', new Blob([Buffer.from('504b0506000000000000000000000000000000000000', 'hex')]), 'ui-test-empty.zip');
  const result = await fetch(origin + '/api/packs', { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: data });
  if (!result.ok) throw new Error('Cannot seed isolated UI fixture');
}
console.log(`Isolated browser QA: ${origin}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
