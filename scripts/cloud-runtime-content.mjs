import fs from 'node:fs';
import path from 'node:path';

// Read only the shipped basic demonstration and its explicitly bound providers.
// Other banks, personal state and development folders never enter the snapshot.
export function stageCloudBasicContent(source, target) {
  const group = '基础题型', bank = `question-banks/${group}/基础题型展示`;
  const raw = JSON.parse(fs.readFileSync(path.join(source, bank, 'bank.json'), 'utf8'));
  const names = new Set(['单选题', '多选题', '判断题', '简答题']);
  for (const reference of [raw.extension, ...raw.questions.map(question => question.extension)].filter(Boolean)) {
    const match = /^extensions\/基础题型\/([^/\\.][^/\\]*)$/.exec(reference.path || '');
    if (!match || ['.', '..'].includes(match[1])) throw new Error('Basic demo must bind an official basic extension');
    names.add(match[1]);
  }
  const copy = (relative, destination = relative) => fs.cpSync(path.join(source, relative), path.join(target, destination), {
    recursive: true, filter: file => !['.instance.json', '.bundle.json', '.state', '.temp', '.git', '.claude'].includes(path.basename(file)),
  });
  for (const name of names) copy(`extensions/${group}/${name}`);
  copy(bank); copy('extensions/README.md');
  const metadata = `question-banks/${group}/.group.json`; if (fs.existsSync(path.join(source, metadata))) copy(metadata);
  fs.writeFileSync(path.join(target, 'extensions', group, '.bundle.json'), JSON.stringify({ schemaVersion: 1, kind: 'extension-bundle' }));
}

export function copyCloudDependencies(moduleRoot, target) {
  const copied = new Set();
  const compatible = metadata => (!metadata.os || metadata.os.includes(process.platform)) && (!metadata.cpu || metadata.cpu.includes(process.arch))
    && (!metadata.libc || metadata.libc.includes(process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'));
  function include(name, from = path.dirname(moduleRoot), optional = false) {
    let directory;
    for (let cursor = from; ; cursor = path.dirname(cursor)) {
      const candidate = path.join(cursor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { directory = candidate; break; }
      if (cursor === path.dirname(cursor)) { if (optional) return; throw new Error('Missing runtime dependency: ' + name); }
    }
    if (copied.has(directory)) return;
    const relative = path.relative(moduleRoot, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dependency is outside the explicit module root');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (!compatible(metadata)) { if (optional) return; throw new Error('Runtime dependency is for a different build platform: ' + name); }
    copied.add(directory);
    fs.cpSync(directory, path.join(target, relative), { recursive: true, filter: file => {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Runtime dependencies cannot contain links');
      return !path.relative(directory, file).split(path.sep).some(part => ['node_modules', 'test', 'tests', '.github', 'benchmark', 'benchmarks'].includes(part));
    } });
    for (const dependency of Object.keys(metadata.dependencies || {})) include(dependency, directory);
    for (const dependency of Object.keys(metadata.optionalDependencies || {})) include(dependency, directory, true);
  }
  for (const name of ['ajv', 'qrcode-generator', 'yauzl', 'yazl', '@napi-rs/canvas']) include(name);
}
