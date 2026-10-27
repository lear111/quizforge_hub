// Assemble reviewed binaries and a practice-only source archive; never copies data or env files.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [directory,release]=process.argv.slice(2);
if(!directory||!release||!/^[a-zA-Z0-9-]+$/.test(release))throw new Error('Usage: node scripts/prepare-java-release.mjs .temp/<new-directory> <release>');
const stage=path.resolve(root,directory);
if(!stage.startsWith(path.join(root,'.temp')+path.sep)||fs.existsSync(stage))throw new Error('Use a new staging directory inside .temp.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safe=p=>{const full=path.resolve(root,p);if(!full.startsWith(root+path.sep)||fs.lstatSync(full).isSymbolicLink()||!fs.statSync(full).isFile())throw new Error('Invalid release input: '+p);return full;};
const record=p=>{const data=fs.readFileSync(safe(p));return {path:p,bytes:data.length,sha256:sha(data)};};
const sources=new Set();
function follow(p){
  if(sources.has(p))return;safe(p);sources.add(p);
  const source=fs.readFileSync(path.join(root,p),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){
    const imported=path.posix.normalize(path.posix.join(path.posix.dirname(p),match[1]));
    if(imported.endsWith('.mjs'))follow(imported);
  }
}
follow('scripts/cloud-practice-site.mjs');
for(const p of ['practice/public/styles.css','practice/public/quizforge-icon.png','practice/public/activity.js','practice/public/admin-contact.js','practice/public/admin-contact.css'])sources.add(p);
for(const p of fs.readdirSync(path.join(root,'practice/public/cloud')))sources.add('practice/public/cloud/'+p);
const practice=[...sources].sort();
if(practice.some(p=>p!=='scripts/cloud-practice-site.mjs'&&!p.startsWith('practice/server/')&&!p.startsWith('practice/public/')))throw new Error('Unexpected source in practice graph');
const jar=path.join(root,'java-hub/target/quizforge-hub-0.1.0-java-preview.jar');if(!fs.existsSync(jar))throw new Error('Build the Java JAR first');
fs.mkdirSync(stage,{recursive:true});
fs.copyFileSync(jar,path.join(stage,'quizforge-hub.jar'));
const list=path.join(stage,'practice-files.txt');fs.writeFileSync(list,practice.join('\n')+'\n');
execFileSync('tar',['-czf',path.join(stage,'practice-source.tar.gz'),'-C',root,'-T',list],{stdio:'inherit'});
const baseCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const practiceManifest={schemaVersion:1,purpose:'retained-practice-service-only',baseCommit,includesUncommittedChanges:true,files:practice.map(record),archiveSha256:sha(fs.readFileSync(path.join(stage,'practice-source.tar.gz')))};
fs.writeFileSync(path.join(stage,'practice-manifest.json'),JSON.stringify(practiceManifest,null,2)+'\n');
const entries=['Start-Java-Hub.ps1','scripts/Admin-Java-Hub.ps1','scripts/Verify-Java-Hub.ps1','package.json','scripts/start-java-hub.mjs','scripts/prepare-java-release.mjs','java-hub/pom.xml','deploy/quizforge-hub-java-test.service','deploy/upgrade-java-test.sh','deploy/upgrade-java-practice-test.sh','scripts/verify-java-test-deployment.py','scripts/verify-java-test-accounts.py','scripts/verify-java-test-complete.py',...practice];
function walk(p){for(const item of fs.readdirSync(path.join(root,p),{withFileTypes:true})){const name=p+'/'+item.name;if(item.isDirectory())walk(name);else entries.push(name);}}
walk('java-hub/src/main');
const manifest={schemaVersion:1,release,baseCommit,branch:execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),includesUncommittedChanges:true,phase:'hub-feature-parity',jarSha256:sha(fs.readFileSync(jar)),practiceManifestSha256:sha(fs.readFileSync(path.join(stage,'practice-manifest.json'))),validation:{requiredCommand:'scripts/Verify-Java-Hub.ps1',results:'Record the current validation log with this release; counts are not inferred by this packer.'},files:[...new Set(entries)].sort().map(record)};
fs.writeFileSync(path.join(stage,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
for(const p of ['deploy/quizforge-hub-java-test.service','deploy/upgrade-java-test.sh','deploy/upgrade-java-practice-test.sh','scripts/verify-java-test-deployment.py','scripts/verify-java-test-accounts.py','scripts/verify-java-test-complete.py'])fs.copyFileSync(path.join(root,p),path.join(stage,path.basename(p)));
console.log(JSON.stringify({stage,release,jarSha256:manifest.jarSha256,practiceFiles:practice.length,sourceFiles:manifest.files.length,sourceManifestSha256:sha(fs.readFileSync(path.join(stage,'source-manifest.json')))},null,2));
