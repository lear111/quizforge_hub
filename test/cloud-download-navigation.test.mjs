import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped delegated listener itself without startup fetches or a
// browser session. This verifies default navigation, not a screenshot/UI pass.
const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf("document.addEventListener('click', async event => {");
const end = source.indexOf("document.addEventListener('change',", start);
assert.ok(start >= 0 && end > start);
function listener(environment = {}) {
  let callback;
  vm.runInNewContext(source.slice(start, end), {
    practiceOrigin: 'https://practice.treenewbee.cloud',
    toast: error => { throw new Error(error); },
    ...environment,
    document: { ...environment.document, addEventListener: (type, handler) => { assert.equal(type, 'click'); callback = handler; } },
  });
  return callback;
}
function event(element, extra = {}) {
  return { target: { closest: () => element }, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...extra };
}

test('cloud import anchor keeps normal, signed-out, and modified-click browser navigation', async () => {
  for (const user of [null, { id: 'synthetic-user' }]) {
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const anchor = { dataset: { action: 'download-cloud' }, hasAttribute: () => false, matches: selector => selector === 'a[href]' };
      const click = event(anchor, modifiers);
      await listener({ user })(click);
      assert.equal(click.defaultPrevented, false, 'cloud import must follow its href');
    }
  }
});

test('same-origin inline cloud import still cancels default and reports progress', async () => {
  const status = { textContent: '', append: () => {} };
  const button = { dataset: { action: 'download-cloud' }, hasAttribute: () => false, disabled: false, matches: () => false };
  const click = event(button);
  const handler = listener({
    practiceOrigin: '', user: { id: 'synthetic-user' }, currentPack: { id: 'synthetic-pack', revision: 1 },
    document: {
      querySelector: () => status, createElement: () => ({}),
    },
    jsonOptions: body => body,
    api: async (route, body) => { assert.equal(route, '/api/cloud/library/from-hub'); assert.equal(body.packId, 'synthetic-pack'); },
  });
  await handler(click);
  assert.equal(click.defaultPrevented, true); assert.equal(button.disabled, false); assert.equal(status.textContent, '');
});

test('the shared desktop/Android scheme anchor is not intercepted by the Hub listener', async () => {
  const anchor = { dataset: { localImport: '' }, hasAttribute: () => false };
  const click = event(anchor); await listener({ user: null })(click);
  assert.equal(click.defaultPrevented, false);
});

test('anonymous file fallback uses the existing download route without login or app launch', async () => {
  const navigations = [];
  const button = { dataset: { action: 'download' }, hasAttribute: () => false, innerHTML: '下载题库文件' };
  const click = event(button);
  await listener({ user: null, currentPack: { id: 'public-bank', archive: { name: 'example.qbank' } },
    api: async route => { assert.equal(route, '/api/packs/public-bank/download-status'); }, toast() {},
    showAuth: () => assert.fail('public downloads must stay anonymous'),
    document: { body: { append() {} }, createElement: tag => { assert.equal(tag, 'a'); return { click() { navigations.push([this.href, this.download]); }, remove() {} }; } },
  })(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(navigations, [['/api/packs/public-bank/download', 'example.qbank']]);
  assert.equal(button.disabled, false); assert.equal(button.innerHTML, '下载题库文件');
});
