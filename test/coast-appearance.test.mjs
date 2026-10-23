import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ordinaryPracticeAsset } from '../cloud/practice-ui.mjs';

const runtime = process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-20261023-coast-verified', import.meta.url));
const enabled = fs.existsSync(path.join(runtime, 'snapshot.json'));
const read = file => fs.readFileSync(path.join(runtime, 'core/web', file), 'utf8');
const uiPackage = process.env.QFH_TEST_UI_PACKAGE;
const base = '/cloud/practice/11111111-1111-4111-8111-111111111111';
test('cloud coast defaults preserve existing image preferences and report the Web coast appearance value', { skip: !enabled }, async () => {
  const source = ordinaryPracticeAsset('shell/appearance.js', read('shell/appearance.js'), base);
  const appearance = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const storage = value => ({ getItem: () => JSON.stringify(value || {}) });
  const fresh = appearance.readAppearance(storage());
  assert.equal(fresh.theme, 'image'); assert.equal(fresh.dim, 15); assert.equal(fresh.clear.image, 70);
  const coast = appearance.readAppearance(storage({ theme: 'coast' }));
  assert.equal(coast.dim, 30); assert.equal(coast.clear.coast, 65);
  const saved = appearance.readAppearance(storage({ theme: 'coast', dim: 45, custom: true, clear: { image: 55, coast: 40 } }));
  assert.equal(saved.theme, 'coast'); assert.equal(saved.dim, 45); assert.equal(saved.clear.coast, 40); assert.equal(saved.clear.image, 55); assert.equal(saved.custom, true);
  for (const theme of ['default', 'mist', 'paper', 'sepia', 'green', 'image']) assert.equal(appearance.readAppearance(storage({ theme, dim: 20 })).theme, theme);
  const root = { dataset: {}, style: { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; }, getPropertyValue(key) { return this[key]; } } };
  appearance.applyAppearance(root, coast);
  assert.deepEqual(appearance.readHostAppearance(root), { theme: 'coast', transparency: .65 });
});
test('coast illustration, theme controls and visible settings icon ship together through the cloud adapter', { skip: !enabled }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'snapshot.json')));
  const lock = JSON.parse(fs.readFileSync(new URL('../deploy/web-workspace-20261023.json', import.meta.url)));
  assert.equal(manifest.sourceRevision, lock.sourceRevision); assert.equal(manifest.includesWorkingTree, true);
  assert.deepEqual(manifest.sourceOverrides, lock.overrides.map(({ path, sha256 }) => ({ path, sha256 })));
  assert.equal(manifest.sourceLockSha256, createHash('sha256').update(fs.readFileSync(new URL('../deploy/web-workspace-20261023.json', import.meta.url))).digest('hex'));
  const css = ordinaryPracticeAsset('shell/themes.css', read('shell/themes.css'), base);
  assert.match(css, new RegExp(base + '/assets/backgrounds/coast\\.svg')); assert.doesNotMatch(css, /url\("\/assets\//);
  assert.match(read('shell/network-settings.css'), /network-settings-entry[^}]*background:#ffffffc7/); assert.match(read('shell/network-settings.css'), /stroke-width:1\.8/);
  assert.match(read('index.html'), /id="appearance-image-actions"/); assert.match(read('shell/appearance.js'), /id:'coast',label:'青屿'/);
  const svg = fs.readFileSync(path.join(runtime, 'core/web/assets/backgrounds/coast.svg'));
  assert.equal(createHash('sha256').update(svg).digest('hex'), manifest.inventory.find(row => row.path === 'core/web/assets/backgrounds/coast.svg').sha256);
});
test('cloud theme controls retain custom pictures and refreshed preferences, using coast defaults only for an untouched mask', { skip: !enabled || !uiPackage }, async t => {
  const { JSDOM } = createRequire(path.resolve(uiPackage))('jsdom');
  const source = ordinaryPracticeAsset('shell/appearance.js', read('shell/appearance.js'), base);
  const appearance = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  function fixture(saved) {
    const dom = new JSDOM(ordinaryPracticeAsset('index.html', read('index.html'), base)); t.after(() => dom.window.close());
    let value = saved && JSON.stringify(saved), removed = 0;
    const storage = { getItem: () => value || null, setItem: (_, next) => { value = next; } }, document = dom.window.document;
    const view = appearance.bindAppearanceSettings({ document, storage, images: { get: async () => new Blob(['test picture']), remove: async () => { removed++; } }, URL: { createObjectURL: () => 'blob:test-picture', revokeObjectURL() {} } }); t.after(() => view.destroy());
    const select = id => document.querySelector(`[data-theme="${id}"]`).click();
    return { dom, document, view, select, saved: () => JSON.parse(value), removed: () => removed };
  }
  const fresh = fixture(); await fresh.view.ready; fresh.select('coast');
  assert.equal(fresh.document.getElementById('appearance-dim').value, '30'); assert.equal(fresh.document.getElementById('appearance-clear').value, '65');
  const f = fixture({ theme: 'image', dim: 45, custom: true, clear: { image: 55 } }); await f.view.ready;
  const picture = f.document.documentElement.style.getPropertyValue('--qf-image'); f.select('coast');
  assert.equal(f.view.value.dim, 45); assert.equal(f.document.getElementById('appearance-image-actions').hidden, true);
  const clear = f.document.getElementById('appearance-clear'); clear.value = '40'; clear.dispatchEvent(new f.dom.window.Event('input'));
  const reopened = fixture(f.saved()); await reopened.view.ready;
  assert.equal(reopened.view.value.theme, 'coast'); assert.equal(reopened.view.value.clear.coast, 40);
  reopened.select('image'); assert.equal(reopened.document.documentElement.style.getPropertyValue('--qf-image'), picture);
  assert.equal(reopened.view.value.clear.image, 55); assert.equal(f.removed(), 0); assert.equal(reopened.removed(), 0);
  fresh.select('image'); const dim = fresh.document.getElementById('appearance-dim'); dim.value = '20'; dim.dispatchEvent(new fresh.dom.window.Event('input')); fresh.select('coast'); assert.equal(fresh.view.value.dim, 20);
});
