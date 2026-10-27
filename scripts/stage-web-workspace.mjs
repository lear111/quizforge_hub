import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Reconstruct reviewed inputs without checking out, cleaning or committing the Web worktree.
const repo = fileURLToPath(new URL('..', import.meta.url));
const [web, destination, modules, suppliedLock] = process.argv.slice(2);
if (!web || !destination) throw new Error('Usage: node scripts/stage-web-workspace.mjs <Web repository> <new runtime> [node_modules] [source lock]');
const lockFile = path.resolve(suppliedLock || path.join(repo, 'practice/vendor/locks/web-workspace-20261027-network.json'));
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
if (!/^[a-f0-9]{40}$/.test(lock.sourceRevision) || lock.includesWorkingTree !== true || !Array.isArray(lock.overrides)) throw new Error('Invalid reviewed source provenance');
const extended = lock.schemaVersion === 2;
if (extended && !/^practice\/vendor\/web-sync-[0-9]{8}(?:-[a-z0-9]{1,32})?$/.test(lock.overrideRoot || '')) throw new Error('Invalid reviewed override directory');
const overrideRoot = path.join(repo, extended ? lock.overrideRoot : 'practice/vendor/web-basic-20261023');
if (fs.realpathSync(overrideRoot) !== path.resolve(overrideRoot)) throw new Error('Reviewed overrides cannot be redirected through links');
const allowed = file => extended
  ? /^(?:core\/(?:server|web|shared)\/|core\/package(?:-lock)?\.json$|extensions\/README\.md$|(?:extensions|question-banks)\/基础题型\/)/.test(file)
  : /^(?:extensions|question-banks)\/基础题型\//.test(file);
const temporary = path.join(repo, '.runtime'); fs.mkdirSync(temporary, { recursive: true });
const source = fs.mkdtempSync(path.join(temporary, 'reviewed-web-source-'));
const archive = path.join(source, 'source.tar');
const paths = ['core/server', 'core/web', 'core/shared', 'core/package.json', 'core/package-lock.json', 'core/test', 'core/scripts/build/stage-basic-content.mjs', 'extensions/README.md', 'extensions/基础题型', 'question-banks/基础题型'];
execFileSync('git', ['archive', '--format=tar', '--output=' + archive, lock.sourceRevision, '--', ...paths], { cwd: path.resolve(web) });
execFileSync('tar', ['-xf', archive, '-C', source]); fs.unlinkSync(archive);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const seen = new Set();
for (const entry of lock.overrides) {
  if (typeof entry.path !== 'string' || !allowed(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(part => ['', '.', '..', '.state', '.temp', '.git', '.claude', 'node_modules', '.instance.json', '.bundle.json'].includes(part)) || seen.has(entry.path)) throw new Error('Invalid reviewed content override path');
  seen.add(entry.path);
  const input = path.join(overrideRoot, entry.path), output = path.join(source, entry.path);
  if (fs.realpathSync(input) !== path.resolve(input) || fs.lstatSync(input).isSymbolicLink() || digest(fs.readFileSync(input)) !== entry.sha256) throw new Error('Reviewed override changed: ' + entry.path);
  const previous = fs.existsSync(output) ? digest(fs.readFileSync(output)) : null;
  if (previous !== entry.baseSha256) throw new Error('Web commit differs from reviewed override base: ' + entry.path);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(input, output);
}
execFileSync(process.execPath, [path.join(repo, 'scripts/stage-cloud-runtime.mjs'), source, path.resolve(destination), path.resolve(modules || path.join(web, 'core/node_modules')), lockFile], { stdio: 'inherit' });
console.log(JSON.stringify({ source, sourceRevision: lock.sourceRevision, includesWorkingTree: true, reviewedOverrides: seen.size }));
