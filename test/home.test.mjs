import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('root and legacy manage routes serve the same marketplace while keeping API permissions', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quizforge-home-'));
  const { server } = await createApp({ dataDir, mailProvider: { ready: false }, downloadNotice: true, downloadNoticeUrl: 'retired-invalid-value' });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(origin + '/'), legacy = await fetch(origin + '/manage/');
  assert.equal(home.status, 200); assert.equal(legacy.status, 200);
  const html = await home.text(); assert.equal(await legacy.text(), html);
  assert.match(html, /src="\/app\.js"/); assert.match(html, /id="auth-dialog"/);
  assert.doesNotMatch(html, /网站仍在完善中|extraction-code|\/notice\./);
  const head = await fetch(origin + '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('cache-control'), 'no-cache'); assert.equal(await head.text(), '');
  for (const route of ['/app.js', '/styles.css', '/local-import.js', '/quizforge-icon.png']) { const asset = await fetch(origin + route); assert.equal(asset.status, 200); await asset.arrayBuffer(); }
  for (const route of ['/notice.html', '/notice.css', '/notice.js', '/public/notice.html']) assert.equal((await fetch(origin + route)).status, 404);
  assert.equal((await fetch(origin + '/api/reviews')).status, 401);
  assert.equal((await fetch(origin + '/api/packs', { method: 'POST', headers: { Origin: origin } })).status, 401);
  assert.equal((await (await fetch(origin + '/api/packs')).json()).count, 0);
});

test('retired notice environment variables cannot restore the temporary page or prevent startup', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quizforge-retired-home-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // Import createApp instead of running the CLI, so this isolated probe never
  // loads a private mail.env. Its environment contains only these synthetic
  // settings; no parent credentials or service configuration are inherited.
  const script = `
    import assert from 'node:assert/strict';
    import { createApp } from ${JSON.stringify(new URL('../server.mjs', import.meta.url).href)};
    const { server } = await createApp({ dataDir: process.argv[1], mailProvider: { ready: false } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/');
      assert.equal(response.status, 200); const html = await response.text();
      assert.match(html, /src="\\/app\\.js"/); assert.doesNotMatch(html, /synthetic-retired-value|notice\\.js/);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dataDir], {
    env: { DOWNLOAD_NOTICE_ENABLED: '1', DOWNLOAD_NOTICE_URL: 'invalid-retired-url', DOWNLOAD_NOTICE_CODE: 'synthetic-retired-value' }, timeout: 15000,
  });
});
