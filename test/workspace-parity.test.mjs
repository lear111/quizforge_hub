import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { CloudAccounts } from '../cloud/accounts.mjs';
import { CloudLibrary, treeBytes } from '../cloud/library.mjs';

const snapshot = process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-20261021-parity', import.meta.url));
const oldSnapshot = fileURLToPath(new URL('../.runtime/web-current', import.meta.url));
const alice = '11111111-1111-4111-8111-111111111111', bob = '22222222-2222-4222-8222-222222222222';
const enabled = fs.existsSync(snapshot) && JSON.parse(fs.readFileSync(path.join(snapshot, 'snapshot.json'))).builtins.some(row => row.extensionId === 'quizforge.short-answer-area');
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-parity-')), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,admin INTEGER,created TEXT)');
  for (const id of [alice, bob]) db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, id, id + '@example.test', id === alice ? 1 : 0, '');
  const accounts = new CloudAccounts(db), f = { directory, db, accounts };
  f.library = await CloudLibrary.create(db, accounts, directory, options.snapshot || snapshot, { unifiedWorkspace: options.unified !== false });
  t.after(async () => { await f.library.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.raw = async (item, route, body, owner = alice, headers = {}) => {
    const bytes = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
    return f.library.practice.api(owner, item.id, route, Object.assign(Readable.from(bytes), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-quizforge-practice-session': '44444444-4444-4444-8444-444444444444', 'x-quizforge-cloud-ai': 'manual', ...headers } }));
  };
  f.api = async (...args) => { const response = await f.raw(...args); assert.equal(response.status, 200, response.bytes.toString()); return JSON.parse(response.bytes); };
  f.action = async (item, question, action, data) => {
    const state = await f.api(item, question);
    return f.api(item, question + '/actions', { requestId: randomUUID(), revision: state.state.revision, contentVersion: state.stamp.contentVersion, action, data });
  };
  return f;
}

test('native workspace import, Hub import and admin delivery share the Web list, preserve deletion semantics and roll back quota failures', { skip: !enabled }, async t => {
  const f = await fixture(t), lib = f.library, item = await lib.ensureDemo(alice), archive = fs.readFileSync(path.join(snapshot, 'basic-demo.qbank'));
  const importHeaders = { 'content-type': 'application/vnd.quizforge.qbank', 'x-quizforge-filename': encodeURIComponent('本地文件.qbank') };
  const added = await f.api(item, '/api/library/import', archive, alice, importHeaders);
  assert.equal(added.catalog.banks.length, 2); assert.equal(added.catalog.canManage, true);
  assert.equal(lib.list(alice).length, 1); assert.equal(lib.list(alice)[0].banks.length, 2);
  const source = { kind: 'hub', packId: randomUUID(), revision: 1 };
  const hub = await lib.install(alice, alice, archive, '公开题库.qbank', source);
  assert.equal(hub.id, item.id); assert.equal(hub.banks.length, 3); assert.equal(lib.findHubImport(alice, source.packId, 1).id, item.id);
  await assert.rejects(lib.install(alice, alice, archive, '重复.qbank', source), /已有题库/);
  assert.equal((await lib.install(alice, alice, archive, '独立副本.qbank', { ...source, newCopy: true })).banks.length, 4);
  const delivered = await lib.install(bob, alice, archive, '私人交付.qbank', { kind: 'admin-delivery' });
  assert.equal(delivered.banks.length, 2); assert.equal(lib.list(bob).length, 1); assert.ok(f.accounts.audits(alice, bob).some(row => row.action === 'private-delivery'));
  await assert.rejects(f.raw(item, '/api/library/index', undefined, bob), /不存在/);
  const usage = f.accounts.status(alice).usage.storageBytes;
  f.accounts.updateLimits(alice, alice, { storageBytes: usage, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '验证统一空间配额回滚');
  await assert.rejects(f.raw(item, '/api/library/import', archive, alice, importHeaders), /存储额度/);
  assert.equal(lib.list(alice)[0].banks.length, 4); assert.equal(f.accounts.status(alice).usage.storageBytes, usage);
  f.accounts.updateLimits(alice, alice, { storageBytes: null, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '恢复测试额度');
  const catalog = await f.api(item, '/api/library/index'), bank = catalog.banks[1];
  const removed = await f.api(item, '/api/library/manage', { kind: 'bank', target: 'item', action: 'delete', path: bank.path });
  assert.deepEqual(removed.removedExtensionGroups, []); assert.deepEqual(removed.retainedExtensionGroups, []);
  assert.deepEqual(removed.catalog.extensions.map(e => e.referencePath), catalog.extensions.map(e => e.referencePath));
  assert.ok(fs.existsSync(path.join(lib.location(alice, item.id), removed.archivedTo, 'receipt.json')));
  assert.equal(f.accounts.status(alice).usage.storageBytes, treeBytes(lib.location(alice, item.id), { ignoreTemp: true, ignorePlatform: true }));
  const staged = path.join(f.directory, 'unapproved'); fs.mkdirSync(staged);
  const packageArchive = new lib.runtime.LibraryArchive(staged, new lib.runtime.ResourceStore(staged)), content = path.join(staged, 'content'); fs.mkdirSync(content);
  await packageArchive.unzip(path.join(snapshot, 'basic-demo.qbank'), content);
  const extension = lib.runtime.scanExtensions(path.join(content, 'extensions'))[0];
  fs.appendFileSync(path.join(extension, 'editor.js'), '\n// changed executable bytes');
  const modified = path.join(staged, 'unapproved.qbank'); await packageArchive.zip(content, modified);
  let runs = 0; const originalRun = lib.engine.run; lib.engine.run = (...args) => { runs++; return originalRun(...args); };
  const rejected = await f.raw(item, '/api/library/import', fs.readFileSync(modified), alice, importHeaders);
  assert.equal(rejected.status, 422); assert.match(rejected.bytes.toString(), /摘要尚未获准/); assert.equal(runs, 0);
  assert.equal(lib.list(alice)[0].banks.length, 3); lib.engine.run = originalRun;
});

test('answer areas use trusted complete images, preserve drafts on failed saves, isolate resources and freeze history', { skip: !enabled }, async t => {
  const f = await fixture(t), lib = f.library, item = await lib.ensureDemo(alice), base = '/api/collections/bank/' + item.banks[0].id, q = base + '/questions/answer-area-information-flow';
  const provider = item.extensions.find(row => row.extensionId === 'quizforge.short-answer-area');
  const page = await f.api(item, `/api/extensions/${provider.id}/${provider.version}/page`); assert.equal(page.answerAreaComponent.version, '1.4.1'); assert.equal(page.answerAreasDeclared, true);
  const area = { type: 'qf-answer-area', formatVersion: 1, id: 'response-answer', width: 760, height: 1800, text: '输入光线，处理图像信号，输出照片。', strokes: [] };
  const answer = value => ({ responses: { answer: value } });
  const saved = await f.action(item, q, 'draft', { answer: answer(area) }); assert.equal(saved.state.status, 'draft');
  const active = lib.practice.sessions.get(item.id); await active.close(); lib.practice.sessions.delete(item.id);
  assert.deepEqual((await f.api(item, q)).state.answer, answer(area));
  const text = await f.action(item, q, 'submit', { answer: answer(area) }); assert.equal(text.state.result.gradingStatus, 'pending'); assert.equal(text.state.answer.responses.answer.snapshot, undefined);
  const start = async () => { const state = await f.api(item, q); return f.api(item, q + '/ai/grade', { requestId: randomUUID(), targetId: 'answer', contentVersion: state.stamp.contentVersion }); };
  let task = await start(), lease = await f.api(item, '/api/cloud-ai/claim', { taskId: task.taskId });
  assert.match(JSON.stringify(lease.input), /输入光线/); assert.doesNotMatch(JSON.stringify(lease.input), /data:image/);
  await f.action(item, q, 'retry', {});
  const canvas = createRequire(path.join(snapshot, 'core/package.json'))('@napi-rs/canvas');
  const photo = canvas.createCanvas(30, 30), paint = photo.getContext('2d'); paint.fillStyle = '#ff0000'; paint.fillRect(0, 0, 30, 30);
  const uploaded = await f.api(item, '/api/resources', { mime: 'image/png', data: photo.toBuffer('image/png').toString('base64') });
  const mixed = { ...area, images: [{ type: 'image', id: 'photo', attrs: { assetId: uploaded.id }, x: 20, y: 1400, width: 80, height: 80 }], strokes: [{ id: 'ink', color: '#000000', width: 4, points: [{ x: 100, y: 1500, pressure: 1 }, { x: 300, y: 1600, pressure: .6 }] }], snapshot: { type: 'image', attrs: { assetId: 'a'.repeat(64) } } };
  const draft = await f.action(item, q, 'draft', { answer: answer(mixed) }); assert.equal(draft.state.answer.responses.answer.snapshot, undefined);
  const usage = f.accounts.status(alice).usage.storageBytes;
  f.accounts.updateLimits(alice, alice, { storageBytes: usage, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '验证混合答案配额回滚');
  await assert.rejects(f.action(item, q, 'submit', { answer: answer(mixed) }), /存储额度/);
  assert.deepEqual((await f.api(item, q)).state.answer, draft.state.answer); assert.equal(f.accounts.status(alice).usage.storageBytes, usage);
  f.accounts.updateLimits(alice, alice, { storageBytes: null, dailyTrafficBytes: null, monthlyTrafficBytes: null }, '恢复测试额度');
  const submitted = await f.action(item, q, 'submit', { answer: answer(mixed) }), id = submitted.state.answer.responses.answer.snapshot.attrs.assetId;
  assert.notEqual(id, 'a'.repeat(64));
  const resource = await f.raw(item, '/api/resources/' + id); assert.equal(resource.status, 200); assert.equal(resource.type, 'image/png'); const png = resource.bytes;
  const image = await canvas.loadImage(png); assert.equal(image.width, 1520); assert.equal(image.height, 3600);
  const full = canvas.createCanvas(image.width, image.height), ctx = full.getContext('2d'); ctx.drawImage(image, 0, 0);
  assert.deepEqual([...ctx.getImageData(100, 2850, 1, 1).data], [255, 0, 0, 255]);
  task = await start(); lease = await f.api(item, '/api/cloud-ai/claim', { taskId: task.taskId });
  const imageBlocks = lease.input.messages.flatMap(row => Array.isArray(row.content) ? row.content : []).filter(row => row.type === 'image_url');
  assert.equal(imageBlocks.length, 1); assert.ok(imageBlocks[0].image_url.url.startsWith('data:image/png;base64,'));
  const other = await lib.ensureDemo(bob); assert.equal((await f.raw(other, '/api/resources/' + id, undefined, bob)).status, 404);
  await f.action(item, q, 'review', { review: { targetId: 'answer', score: 4.5 } });
  const summary = await f.api(item, base + '/summary'), finished = await f.api(item, base + '/finish', { requestId: randomUUID(), roundId: summary.roundId, summaryVersion: summary.summaryVersion });
  const history = await f.api(item, base + '/history/' + finished.historyId);
  assert.match(JSON.stringify(history), /1\.4\.1/); assert.match(JSON.stringify(history), new RegExp(id));
  const removed = await f.api(item, '/api/library/manage', { kind: 'bank', target: 'item', action: 'delete', path: item.banks[0].path });
  assert.equal(removed.catalog.banks.length, 0);
  assert.deepEqual(await f.api(item, base + '/history/' + finished.historyId), history);
  assert.deepEqual((await f.raw(item, '/api/resources/' + id)).bytes, resource.bytes);
});

test('legacy cloud roots merge without regenerating bank IDs, answers or frozen history; aliases and originals survive', { skip: !enabled || !fs.existsSync(oldSnapshot) }, async t => {
  const f = await fixture(t, { unified: false, snapshot: oldSnapshot });
  const first = await f.library.demo(alice), second = await f.library.demo(alice), originalRoot = f.library.location(alice, second.id);
  const base = '/api/collections/bank/' + second.banks[0].id, q = base + '/questions/single-sample-text';
  const raw = JSON.parse(fs.readFileSync(path.join(oldSnapshot, 'basic-content/question-banks/基础题型/基础题型展示/bank.json')));
  await f.action(second, q, 'submit', { answer: { selectedOptionId: raw.questions[0].data.correctOptionId } });
  const summary = await f.api(second, base + '/summary'), finished = await f.api(second, base + '/finish', { requestId: randomUUID(), roundId: summary.roundId, summaryVersion: summary.summaryVersion });
  const saved = await f.api(second, q), history = await f.api(second, base + '/history/' + finished.historyId);
  const example = second.extensions.find(row => row.extensionId === 'quizforge.single-choice'), exampleBase = '/api/collections/extension/' + example.id;
  const overview = await f.api(second, exampleBase), exampleQuestion = exampleBase + '/questions/' + overview.questions[0].id;
  const currentExample = await f.library.practice.sessions.get(second.id).library.collection('extension', example.id);
  await f.action(second, exampleQuestion, 'submit', { answer: { selectedOptionId: currentExample.questions[0].data.correctOptionId } });
  const exampleSaved = await f.api(second, exampleQuestion);
  await f.library.close();
  f.library = await CloudLibrary.create(f.db, f.accounts, f.directory, snapshot, { unifiedWorkspace: true });
  const firstConflict = path.join(f.library.location(alice, first.id), 'migration-check.txt'), secondConflict = path.join(originalRoot, 'migration-check.txt');
  fs.writeFileSync(firstConflict, 'first original'); fs.writeFileSync(secondConflict, 'second original');
  const usage = f.accounts.status(alice).usage.storageBytes;
  await assert.rejects(f.library.ensureDemo(alice), /内容冲突/);
  assert.equal(f.library.list(alice).length, 2); assert.equal(f.accounts.status(alice).usage.storageBytes, usage);
  assert.equal(fs.readFileSync(firstConflict, 'utf8'), 'first original'); assert.equal(fs.readFileSync(secondConflict, 'utf8'), 'second original');
  fs.unlinkSync(firstConflict); fs.unlinkSync(secondConflict);
  const merged = await f.library.ensureDemo(alice);
  assert.equal(merged.id, first.id); assert.equal(f.library.list(alice).length, 1); assert.equal(merged.banks.length, 2);
  assert.ok(merged.banks.some(bank => bank.id === second.banks[0].id));
  assert.deepEqual((await f.api(second, q)).state, saved.state);
  assert.deepEqual(await f.api(second, base + '/history/' + finished.historyId), history);
  const movedExample = merged.extensions.find(row => row.extensionId === example.extensionId && row.referencePath !== first.extensions.find(value => value.extensionId === example.extensionId).referencePath);
  assert.deepEqual((await f.api(second, '/api/collections/extension/' + movedExample.id + '/questions/' + overview.questions[0].id)).state, exampleSaved.state);
  assert.ok(fs.existsSync(originalRoot)); assert.equal(f.library.owned(alice, second.id).id, first.id);
  assert.equal(f.accounts.status(alice).usage.storageBytes, treeBytes(f.library.location(alice, first.id), { ignoreTemp: true, ignorePlatform: true }));
  await assert.rejects(f.raw(second, q, undefined, bob), /不存在/);
  assert.equal((await f.library.ensureDemo(alice)).banks.length, 2);
});

test('workspace module graph and controls follow pinned Web, with only cloud settings and transport adapters', { skip: !enabled }, async t => {
  const f = await fixture(t), lib = f.library, item = await lib.ensureDemo(alice), base = '/cloud/practice/' + item.id + '/';
  const asset = name => lib.practice.asset(alice, item.id, name, { ordinary: true }).bytes.toString();
  const html = asset('index.html'), upstream = fs.readFileSync(path.join(snapshot, 'core/web/index.html'), 'utf8');
  const lock = JSON.parse(fs.readFileSync(new URL('../deploy/web-workspace-20261021.json', import.meta.url))), inventory = new Map(lib.runtime.manifest.inventory.map(row => [row.path, row.sha256]));
  for (const row of lock.inventory) assert.equal(inventory.get(row.path), row.sha256, row.path);
  for (const id of ['library-import', 'library-import-dialog', 'library-import-file', 'library-manage-dialog']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
    assert.equal((upstream.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  }
  const cloud = fs.readFileSync(new URL('../public/cloud/library.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cloud, /切换|createElement\('dialog'\)|cloud-library-open/);
  const css = fs.readFileSync(new URL('../public/cloud/experience.css', import.meta.url), 'utf8'); assert.doesNotMatch(css, /#library-import\s*\{[^}]*display\s*:\s*none/);
  assert.match(html, /返回编辑/); assert.match(asset('editor/editor-navigation.js'), /UNSAVED_EDITOR_CHANGES/); assert.doesNotMatch(asset('app.js'), /onCapture/);
  assert.throws(() => asset('draft/whiteboard-capture.js'), /不存在/);
  assert.throws(() => asset('server/host/http/server.js'), /不存在/);
  const visited = new Set(), queue = ['app.js'];
  while (queue.length) {
    const file = queue.pop(); if (visited.has(file)) continue; visited.add(file);
    const source = asset(file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"\n]+\.(?:js|css))['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith(base)) { queue.push(specifier.slice(base.length)); continue; }
      if (specifier.startsWith('/cloud/')) { assert.ok(fs.existsSync(new URL('../public' + specifier, import.meta.url))); continue; }
      if (!specifier.startsWith('.')) continue;
      const url = new URL(specifier, 'https://practice.example' + base + file);
      assert.ok(url.pathname.startsWith(base), url.pathname); queue.push(url.pathname.slice(base.length));
    }
  }
  for (const name of ['shared/answer-area/1.4.0/model.js', 'shared/ink/1.0.0/renderer.js', 'editor/editor-navigation.js', 'editor/editor-session.js', 'draft/answer-ink.js', 'bridge/frame-capture.js']) { assert.ok(visited.has(name) || asset(name)); }
  assert.ok(visited.size > 40);
});
