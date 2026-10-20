import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CloudError } from './accounts.mjs';

const loaded = new Map();
export async function loadRuntime(directory) {
  const root = fs.realpathSync(path.resolve(directory));
  if (loaded.has(root)) return loaded.get(root);
  const pending = (async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.inventory) || !Array.isArray(manifest.builtins) || manifest.inventory.length > 5000) throw new Error('Invalid cloud runtime snapshot');
    for (const entry of manifest.inventory) {
      if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').includes('..')) throw new Error('Invalid runtime inventory path');
      const file = path.join(root, entry.path), stat = fs.lstatSync(file);
      if (!stat.isFile() || fs.realpathSync(file) !== file || stat.size > 32 * 1024 ** 2 || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) throw new Error('Cloud runtime snapshot changed; stage a new snapshot');
    }
    const core = path.join(root, 'core');
    const module = name => import(pathToFileURL(path.join(core, 'server/host', name)).href);
    const [archive, resources, library, validation, rules, directories] = await Promise.all([
      module('library/library-archive.js'), module('resources/resources.js'), module('library/library.js'), module('library/import-validation.js'), module('extensions/rule-engine.js'), module('library/directories.js'),
    ]);
    return { root, core, manifest, ...archive, ...resources, ...library, ...validation, ...rules, ...directories };
  })();
  loaded.set(root, pending);
  try { return await pending; } catch (error) { loaded.delete(root); throw error; }
}
export function requireRuntime(value) { if (!value) throw new CloudError(503, '云端题库运行时尚未配置'); return value; }
