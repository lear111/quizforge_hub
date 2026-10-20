import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extensionDigest } from '../cloud/extension-review.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.resolve(process.argv[2] || path.join(repo, '..', 'quizforge_web'));
const target = path.resolve(process.argv[3] || path.join(repo, '.runtime', 'web-current'));
if (fs.existsSync(target)) throw new Error('Runtime destination already exists; use a new versioned destination');
if (!fs.existsSync(path.join(source, 'core', 'package-lock.json'))) throw new Error('Expected the existing QuizForge Web checkout');
fs.mkdirSync(target, { recursive: true });
const core = path.join(target, 'core');
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: file => !/\.test\.(?:m?js)$/.test(file) && !['.state', '.temp', '.git', '.claude'].includes(path.basename(file)) });
for (const name of ['server', 'web', 'shared', 'package.json', 'package-lock.json']) copy(path.join(source, 'core', name), path.join(core, name));
const modules = ['ajv', 'qrcode-generator', 'yauzl', 'yazl'];
const copied = new Set();
for (const name of modules) {
  if (copied.has(name)) continue;
  const directory = path.join(source, 'core', 'node_modules', name), metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.os || metadata.cpu) throw new Error('Cloud snapshot accepts portable JavaScript runtime dependencies only');
  copy(directory, path.join(core, 'node_modules', name)); copied.add(name); modules.push(...Object.keys(metadata.dependencies ?? {}));
}
// Export only the four official basic extensions and the shipped demonstration
// bank. Never copy the user's library, .state, AI config or development folders.
const { stageBasicContent } = await import(pathToFileURL(path.join(source, 'core/scripts/build/stage-basic-content.mjs')));
stageBasicContent(source, path.join(target, 'basic-content'));
const { LibraryArchive } = await import(pathToFileURL(path.join(core, 'server/host/library/library-archive.js')));
const { ResourceStore } = await import(pathToFileURL(path.join(core, 'server/host/resources/resources.js')));
const basic = path.join(target, 'basic-content'), archive = new LibraryArchive(basic, new ResourceStore(basic));
const exported = await archive.exportGroup('基础题型');
fs.copyFileSync(exported.file, path.join(target, 'basic-demo.qbank')); exported.close();
const reviews = fs.readdirSync(path.join(basic, 'extensions', '基础题型')).filter(name => !name.startsWith('.')).map(name => extensionDigest(path.join(basic, 'extensions', '基础题型', name)));
let revision = 'working-tree';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { }
const inventory = [];
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('Runtime snapshot cannot contain links');
    if (stat.isDirectory()) visit(file);
    else inventory.push({ path: path.relative(target, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
}
visit(target);
fs.writeFileSync(path.join(target, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, sourceRevision: revision, includesWorkingTree: true, builtins: reviews, inventory }, null, 2));
console.log(JSON.stringify({ target, files: inventory.length, extensions: reviews.map(item => ({ id: item.extensionId, digest: item.digest })) }));
