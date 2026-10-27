import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extensionDigest } from '../practice/server/cloud/extension-review.mjs';
import { stageCloudBasicContent, copyCloudDependencies } from './cloud-runtime-content.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.resolve(process.argv[2] || path.join(repo, '..', 'quizforge_web'));
const target = path.resolve(process.argv[3] || path.join(repo, '.runtime', 'web-current'));
const moduleRoot = path.resolve(process.argv[4] || path.join(source, 'core', 'node_modules'));
const sourceLockFile = process.argv[5] && path.resolve(process.argv[5]);
const sourceLock = sourceLockFile && JSON.parse(fs.readFileSync(sourceLockFile, 'utf8'));
if (sourceLock && (!/^[a-f0-9]{40}$/.test(sourceLock.sourceRevision) || typeof sourceLock.includesWorkingTree !== 'boolean' || !Array.isArray(sourceLock.overrides) || !Array.isArray(sourceLock.inventory) || createHash('sha256').update(JSON.stringify(sourceLock.inventory)).digest('hex') !== sourceLock.inventorySha256)) throw new Error('Invalid reviewed Web source lock');
if (fs.existsSync(target)) throw new Error('Runtime destination already exists; use a new versioned destination');
if (!fs.existsSync(path.join(source, 'core', 'package-lock.json'))) throw new Error('Expected the existing QuizForge Web checkout');
fs.mkdirSync(target, { recursive: true });
const core = path.join(target, 'core');
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: file => !/\.test\.(?:m?js)$/.test(file) && !['.state', '.temp', '.git', '.claude'].includes(path.basename(file)) });
for (const name of ['server', 'web', 'shared', 'package.json', 'package-lock.json']) copy(path.join(source, 'core', name), path.join(core, name));
// Native canvas must be installed for the machine building this snapshot.
// Build Linux snapshots on Linux; never copy the Windows native binding there.
copyCloudDependencies(moduleRoot, path.join(core, 'node_modules'));
const { createRequire } = await import('node:module');
const canvas = createRequire(path.join(core, 'package.json'))('@napi-rs/canvas');
const smoke = canvas.createCanvas(64, 64); smoke.getContext('2d').fillText('答题区 Aa', 0, 24); smoke.toBuffer('image/png');
stageCloudBasicContent(source, path.join(target, 'basic-content'));
const { LibraryArchive } = await import(pathToFileURL(path.join(core, 'server/host/library/library-archive.js')));
const { ResourceStore } = await import(pathToFileURL(path.join(core, 'server/host/resources/resources.js')));
const basic = path.join(target, 'basic-content'), archive = new LibraryArchive(basic, new ResourceStore(basic));
const exported = await archive.exportGroup('基础题型');
fs.copyFileSync(exported.file, path.join(target, 'basic-demo.qbank')); exported.close();
const reviews = fs.readdirSync(path.join(basic, 'extensions', '基础题型')).filter(name => !name.startsWith('.')).map(name => extensionDigest(path.join(basic, 'extensions', '基础题型', name)));
let revision = sourceLock?.sourceRevision || 'working-tree', includesWorkingTree = sourceLock?.includesWorkingTree ?? true;
try { if (!sourceLock) {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // A clean checkout of core/ is exactly that commit.
  includesWorkingTree = execFileSync('git', ['status', '--porcelain', '--', 'core', 'extensions', 'question-banks'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
} } catch { }
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
if (sourceLock?.inventory) {
  const selected = inventory.filter(row => !row.path.includes('/node_modules/') && row.path !== 'basic-demo.qbank');
  if (JSON.stringify(selected) !== JSON.stringify(sourceLock.inventory)) throw new Error('Staged runtime differs from the reviewed Web source lock');
}
fs.writeFileSync(path.join(target, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, sourceRevision: revision, includesWorkingTree,
  ...(sourceLock ? { sourceLockSha256: createHash('sha256').update(fs.readFileSync(sourceLockFile)).digest('hex'), sourceOverrides: sourceLock.overrides.map(({ path, sha256 }) => ({ path, sha256 })) } : {}),
  runtimeTarget: { platform: process.platform, arch: process.arch, libc: process.platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl' : null }, builtins: reviews, inventory }, null, 2));
console.log(JSON.stringify({ target, files: inventory.length, extensions: reviews.map(item => ({ id: item.extensionId, digest: item.digest })) }));
