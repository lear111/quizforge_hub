import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { publishDownload, unpublishDownload, readDownloads } from '../downloads.mjs';

test('the download page lists published installers and serves them within the file budget', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-downloads-')), source = path.join(dataDir, 'setup.exe');
  const bytes = Buffer.from('synthetic installer bytes'); fs.writeFileSync(source, bytes);
  const app = await createApp({ dataDir, mailProvider: { ready: false }, monthlyBudgetBytes: bytes.length * 2 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });

  assert.deepEqual((await (await fetch(origin + '/api/downloads')).json()).items, []);
  const page = await fetch(origin + '/download'); assert.equal(page.status, 200); assert.match(await page.text(), /下载 QuizForge/);
  assert.equal((await fetch(origin + '/download.js')).status, 200);

  const item = publishDownload(dataDir, { platform: 'windows', source, version: '0.1.0-preview.4', label: '预览版' });
  assert.equal(item.file, 'QuizForge-0.1.0-preview.4-windows.exe'); assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await (await fetch(origin + '/api/downloads')).json()).items, [item]);
  const download = await fetch(origin + '/download/files/' + item.file);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  // Only listed files are served, and every download counts against the site budget.
  for (const name of ['manifest.json', '..%2Fhub.sqlite', 'other.exe']) assert.equal((await fetch(origin + '/download/files/' + name)).status, 404);
  assert.equal((await fetch(origin + '/download/files/' + item.file)).status, 200);
  assert.equal((await fetch(origin + '/download/files/' + item.file)).status, 429);

  // A new version replaces the old file; removing a platform clears it from the page.
  const next = publishDownload(dataDir, { platform: 'windows', source, version: '0.1.0-preview.5' });
  assert.equal(fs.existsSync(path.join(dataDir, 'downloads', item.file)), false); assert.equal(readDownloads(dataDir)[0].file, next.file);
  assert.throws(() => publishDownload(dataDir, { platform: 'mac', source, version: '1' }), /平台/);
  assert.equal(unpublishDownload(dataDir, 'windows'), true); assert.deepEqual(readDownloads(dataDir), []);
});
