import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { enhanceLocalImport } from '../public/local-import.js';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function cloudDownloadButton() {'), end = source.indexOf('function empty(', start);
assert.ok(start >= 0 && end > start);
const pack = { id: '11111111-1111-4111-8111-111111111111', revision: 3, status: 'approved', archive: { name: 'example.qbank' } };
const config = { enabled: true, protocolVersion: 1, scheme: 'quizforge' };

// Small DOM adapter for the shipped enhancement functions. This covers links,
// insertion order and event cancellation; it is not layout or browser acceptance.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.className = ''; this.parent = null; this.text = ''; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  get classList() { return { add: name => { this.className += ' ' + name; } }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === '[data-local-import]') return Object.hasOwn(this.dataset, 'localImport');
    const action = /^\[data-action="([a-z-]+)"\]$/.exec(selector)?.[1];
    return action !== undefined && this.dataset.action === action;
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  after(...nodes) { const siblings = this.parent.children; for (const node of nodes) node.parent = this.parent; siblings.splice(siblings.indexOf(this) + 1, 0, ...nodes); }
  addEventListener(type, handler) { const handlers = this.events.get(type) || []; handlers.push(handler); this.events.set(type, handlers); }
  dispatchEvent(event) { for (const handler of this.events.get(event.type) || []) handler(event); return !event.defaultPrevented; }
}
function fixture(current = pack, capability = config, cloud = {}) {
  const root = new Element('section'), download = new Element('button'); download.className = 'button'; download.dataset.action = 'download'; download.textContent = '下载题库文件'; root.append(download);
  const descendants = (node = root) => [node, ...node.children.flatMap(child => descendants(child))];
  const document = { createElement: tag => new Element(tag), querySelector: selector => descendants().find(node => node.matches(selector)) || null };
  const local = () => enhanceLocalImport({ document, pack: current, config: capability });
  const remote = () => vm.runInNewContext(source.slice(start, end) + '\ncloudDownloadButton();', { document, currentPack: current, cloudEnabled: true, practiceOrigin: 'https://practice.example', ...cloud });
  return { root, download, document, descendants, local, remote, buttons: () => descendants().filter(node => node.className.split(/\s+/).includes('button')) };
}

test('three destinations stay ordered and do not duplicate across enhancement order or rerenders', () => {
  for (const first of ['local', 'remote']) {
    const ui = fixture(); ui[first](); ui[first === 'local' ? 'remote' : 'local'](); ui.local(); ui.remote();
    const [file, native, cloud] = ui.buttons();
    assert.deepEqual(ui.buttons().map(node => node.textContent), ['下载题库文件', '下载并导入到本地', '下载并导入到云端']);
    assert.equal(file, ui.download);
    assert.equal(native.href, `quizforge://hub/import?v=1&pack=${pack.id}&revision=3`);
    assert.equal(cloud.href, `https://practice.example/cloud/import?pack=${pack.id}&revision=3`);
    const localDescription = ui.descendants().find(node => node.id === native.attributes['aria-describedby']);
    assert.equal(localDescription.textContent, '导入当前设备上的 QuizForge，支持电脑和安卓手机、平板。');
    assert.equal(localDescription.parent, native.parent);
    assert.equal(ui.descendants().find(node => node.id === cloud.attributes['aria-describedby']).textContent, '导入账号的云端题库，需登录。');
    const installer = ui.descendants().find(node => node.className === 'download-installers');
    assert.equal(ui.root.children.at(-1), installer);
    const windows = installer.children.find(node => node.tagName === 'a');
    assert.equal(windows.textContent, 'Windows 版下载'); assert.equal(windows.href, 'https://github.com/lear111/quizforge_web/releases');
    assert.equal(windows.target, '_blank'); assert.equal(windows.rel, 'noopener noreferrer');
    assert.ok(installer.children.some(node => node.textContent === 'Android 安装包待发布' && !node.href));
    assert.match(installer.textContent, /未安装客户端或浏览器未唤起/);
  }
});

test('native click only reports the launch request and leaves system navigation uncancelled', () => {
  const ui = fixture(); ui.local();
  const anchor = ui.document.querySelector('[data-local-import]');
  const status = ui.descendants().find(node => node.attributes.role === 'status');
  assert.equal(status.textContent, ''); assert.equal(status.attributes['aria-live'], 'polite');
  const click = new Event('click', { cancelable: true }); anchor.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
  assert.equal(status.textContent, '已请求打开 QuizForge，请在系统提示中允许打开');
  assert.equal(status.parent, anchor.parent);
  assert.equal(ui.buttons()[0], ui.download, 'file fallback must remain available after requesting an app launch');
});

test('only approved qbank attachments offer direct import; disabling native capability preserves other destinations', () => {
  for (const candidate of [{ ...pack, status: 'pending' }, { ...pack, status: 'rejected' }, ...['zip', 'rar', '7z'].map(ext => ({ ...pack, archive: { name: 'example.' + ext } }))]) {
    const ui = fixture(candidate); ui.local(); ui.remote(); assert.deepEqual(ui.buttons(), [ui.download]);
  }
  const disabled = fixture(pack, { ...config, enabled: false }); disabled.local(); disabled.remote();
  assert.deepEqual(disabled.buttons().map(node => node.textContent), ['下载题库文件', '下载并导入到云端']);
  const inline = fixture(pack, config, { practiceOrigin: '' }); inline.local(); inline.remote();
  const cloud = inline.document.querySelector('[data-action="download-cloud"]');
  assert.equal(cloud.tagName, 'button'); assert.equal(cloud.type, 'button');
  assert.ok(inline.document.querySelector('.cloud-download-status'));
});
