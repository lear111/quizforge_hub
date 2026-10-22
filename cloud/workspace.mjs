import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CloudError } from './accounts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const conflict = () => new CloudError(409, '旧云端空间存在内容冲突，已保留原题库和记录，请联系管理员处理');

function unique(base, name) {
  let result = name;
  for (let index = 2; fs.existsSync(path.join(base, result)); index++) result = `${name} (${index})`;
  return result;
}

// Never overwrite a saved answer, frozen history or resource with different
// bytes. The caller checkpoints the destination; source roots remain intact.
function mergeFiles(source, destination, transform = null) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw conflict();
  if (stat.isDirectory()) {
    if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) throw conflict();
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (name === '.temp') continue;
      mergeFiles(path.join(source, name), path.join(destination, name), transform);
    }
    return;
  }
  let bytes = fs.readFileSync(source);
  if (transform) ({ destination, bytes } = transform(source, destination, bytes));
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || !fs.readFileSync(destination).equals(bytes)) throw conflict();
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
}

function rewriteBindings(file, mappings) {
  const raw = read(file); let changed = false;
  for (const owner of [raw, ...(raw.questions || [])]) {
    const reference = owner.extension;
    if (reference && mappings.has(reference.path)) { reference.path = mappings.get(reference.path); changed = true; }
  }
  if (changed) write(file, raw);
}

function mergeLocations(source, destination) {
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(destination)) { fs.copyFileSync(source, destination); return; }
  const a = read(destination), b = read(source);
  if (a.schemaVersion !== 1 || b.schemaVersion !== 1 || !a.routes || !b.routes || !Array.isArray(a.moves) || !Array.isArray(b.moves)) throw conflict();
  for (const [key, value] of Object.entries(b.routes)) {
    if (Object.hasOwn(a.routes, key) && a.routes[key] !== value) throw conflict();
    a.routes[key] = value;
  }
  a.moves = [...new Map([...a.moves, ...b.moves].map(move => [JSON.stringify(move), move])).values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  write(destination, a);
}

export async function mergeWorkspace(library, workspace, others) {
  const r = library.runtime, destination = library.location(workspace.user_id, workspace.id);
  for (const row of others) {
    const source = library.location(row.user_id, row.id);
    library.practice.approved(source);
    const oldLibrary = new r.Library(source, r.core, library.engine);
    let before;
    try { before = oldLibrary.index(); } finally { oldLibrary.close(); }
    // Every cloud format-3 import has a host-local bank instance. Do not invent
    // new identities for unexpected legacy data or silently detach its state.
    if (before.banks.some(bank => bank.error || !bank.instanceId) || before.extensions.some(extension => extension.error)) throw conflict();
    const mappings = new Map(), stateKeys = new Map();
    const extensionBase = path.join(destination, 'extensions'); fs.mkdirSync(extensionBase, { recursive: true });
    const groups = fs.readdirSync(path.join(source, 'extensions')).filter(name => fs.lstatSync(path.join(source, 'extensions', name)).isDirectory());
    for (const group of groups) {
      if (!group || group.includes('/') || group.includes('\\')) throw conflict();
      const next = unique(extensionBase, group);
      mergeFiles(path.join(source, 'extensions', group), path.join(extensionBase, next));
      for (const extension of before.extensions.filter(value => value.group === group)) {
        const previousPath = extension.referencePath, nextPath = `extensions/${next}/${path.basename(extension.path)}`;
        mappings.set(previousPath, nextPath);
        const nextId = 'p.' + hash(nextPath);
        if (!extension.bundleScoped && extension.id !== 'p.' + hash(previousPath)) throw conflict();
        stateKeys.set(`extension:${extension.id}:path:${previousPath}`, `extension:${nextId}:path:${nextPath}`);
        const directory = path.join(destination, nextPath), manifest = read(path.join(directory, 'manifest.json'));
        if (manifest.examples) {
          const example = path.resolve(directory, manifest.examples), relative = path.relative(directory, example);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw conflict();
          rewriteBindings(example, mappings);
        }
      }
    }
    for (const name of fs.readdirSync(path.join(source, 'extensions'))) if (!groups.includes(name)) mergeFiles(path.join(source, 'extensions', name), path.join(extensionBase, name));
    const bankBase = path.join(destination, 'question-banks'); fs.mkdirSync(bankBase, { recursive: true });
    for (const entry of fs.readdirSync(path.join(source, 'question-banks'))) {
      const target = path.join(bankBase, unique(bankBase, entry));
      mergeFiles(path.join(source, 'question-banks', entry), target);
      for (const bank of before.banks) if (bank.path === entry || bank.path.startsWith(entry + '/')) {
        const file = path.join(target, bank.path === entry ? '' : bank.path.slice(entry.length + 1), 'bank.json');
        rewriteBindings(file, mappings);
      }
    }
    const oldState = path.join(source, '.state'), newState = path.join(destination, '.state'); fs.mkdirSync(newState, { recursive: true });
    if (fs.existsSync(oldState)) for (const entry of fs.readdirSync(oldState)) {
      if (['host.lock', 'validation-cache'].includes(entry)) continue;
      if (entry === 'bank-locations.json') { mergeLocations(path.join(oldState, entry), path.join(newState, entry)); continue; }
      mergeFiles(path.join(oldState, entry), path.join(newState, entry), (file, target, bytes) => {
        if (path.dirname(file) === oldState && /^[a-f0-9]{64}\.json$/.test(entry)) {
          const value = JSON.parse(bytes);
          if (stateKeys.has(value.collection)) {
            value.collection = stateKeys.get(value.collection);
            target = path.join(newState, hash(value.collection) + '.json'); bytes = Buffer.from(JSON.stringify(value) + '\n');
          }
        }
        return { destination: target, bytes };
      });
    }
    for (const entry of fs.readdirSync(source)) if (!['question-banks', 'extensions', '.state', '.temp'].includes(entry)) mergeFiles(path.join(source, entry), path.join(destination, entry));
  }
  const reader = new r.Library(destination, r.core, library.engine);
  try {
    const catalog = await reader.catalog();
    if (catalog.banks.some(bank => bank.error) || catalog.extensions.some(extension => extension.error) || new Set(catalog.banks.map(bank => bank.id)).size !== catalog.banks.length) throw conflict();
    return catalog;
  } finally { reader.close(); }
}
