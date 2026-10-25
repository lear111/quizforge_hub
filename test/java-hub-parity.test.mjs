import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {legacyDatabase} from './helpers/legacy-data.mjs';
import {snapshot} from '../scripts/snapshot-hub-for-java.mjs';
const jar=process.env.HUB_JAVA_JAR;
let sequence=0;const randomUUID=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const frozen=JSON.parse(fs.readFileSync(new URL('./fixtures/node-hub-contract.json',import.meta.url),'utf8'));
const hash=raw=>createHash('sha256').update(raw).digest('hex');
test('Java preserves frozen public Hub responses, session permissions and traffic boundaries',{skip:!jar,timeout:150000},async t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'qfh-java-parity-')),source=path.join(work,'node'),target=path.join(work,'java');
  const original=legacyDatabase(source);original.close();
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const db=new DatabaseSync(path.join(source,'hub.sqlite'));
  const author=randomUUID(),admin=randomUUID(),blocked=randomUUID(),publicId=randomUUID(),pendingId=randomUUID(),imageId=randomUUID(),fileId=randomUUID();
  const token='a'.repeat(64),adminToken='b'.repeat(64),blockedToken='c'.repeat(64),expired='d'.repeat(64),now='2026-10-24T12:00:00.000Z';
  for(const [id,name,isAdmin]of [[author,'测试作者',0],[admin,'测试管理员',1],[blocked,'已停用',0]])db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id,id+'@example.test',name,'!fixture',isAdmin,now);
  for(const [raw,id,expires]of [[token,author,Date.now()+3600000],[adminToken,admin,Date.now()+3600000],[blockedToken,blocked,Date.now()+3600000],[expired,author,0]])db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(raw),id,expires);
  db.prepare('INSERT INTO user_blocks VALUES (?,?,?,?)').run(blocked,admin,'test only',Date.now());
  db.prepare('INSERT INTO user_phones VALUES (?,?,?)').run(author,'+8613800000000',0);db.prepare('INSERT INTO unverified_contacts VALUES (?,?,?)').run(author,'phone','+8613800000000');
  for(const [id,status,title]of [[publicId,'approved','2024 年数学 100%_题库'],[pendingId,'pending','未审核题库']])db.prepare('INSERT INTO packs (id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,author,title,'真实接口对照','<b>仅作为文字展示</b>','其他','["数学"]','2.0',now,now,status);
  const archive=Buffer.from('504b0506000000000000000000000000000000000000','hex'),png=Buffer.from('89504e470d0a1a0a','hex');
  for(const [id,kind,name,mime,bytes]of [[fileId,'archive','含 空格的题库.qbank','application/octet-stream',archive],[imageId,'image','截图.png','image/png',png]]){fs.writeFileSync(path.join(source,'files',id),bytes);db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(id,publicId,kind,name,mime,bytes.length,hash(bytes));}
  db.prepare('INSERT INTO comments VALUES (?,?,?,?,?)').run(randomUUID(),publicId,author,'<script>作为评论文本</script>',now);
  db.prepare('UPDATE admin_contact SET content=?,revision=2').run('测试联系方式\n<b>按原文显示</b>');
  const release=frozen.installer;fs.mkdirSync(path.join(source,'downloads'));fs.writeFileSync(path.join(source,'downloads',release.file),'synthetic installer');fs.writeFileSync(path.join(source,'downloads/manifest.json'),JSON.stringify({schemaVersion:1,items:[release]}));
  db.close();
  await assert.rejects(snapshot(source,target),/Stop Hub writes/);
  await snapshot(source,target,{sourceStopped:true});await assert.rejects(snapshot(source,target,{sourceStopped:true}),/already exists/);
  const java=spawn(process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java',['-jar',path.resolve(jar),'--server.port=0','--hub.data-dir='+target,'--hub.monthly-budget-bytes=1000','--hub.cloud-enabled=true'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',javaOrigin;const exit=once(java,'exit');java.stderr.on('data',chunk=>{output+=chunk;});java.stdout.on('data',chunk=>{output+=chunk;const match=/Tomcat started on port (\d+)/.exec(output);if(match)javaOrigin='http://127.0.0.1:'+match[1];});
  t.after(async()=>{if(java.exitCode===null){java.kill();await exit;}});
  const deadline=Date.now()+60000;while(!javaOrigin&&Date.now()<deadline&&java.exitCode===null)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(javaOrigin,'Java failed to start: '+output.slice(-3000));
  const get=(origin,route,raw)=>fetch(origin+route,{headers:raw?{Cookie:'qfh_session='+raw}:{}});
  let requestIndex=0;const compare=async(route,raw)=>{const expected=frozen.requests[requestIndex++];assert.equal(expected.route,route);assert.equal(expected.token,raw??null);const response=await get(javaOrigin,route,raw);assert.equal(response.status,expected.status,route);assert.deepEqual(await response.json(),expected.body,route);};
  await t.test('catalogue, literal search, sorting and pagination preserve response shape',async()=>{for(const route of ['/api/packs','/api/packs?q=100%25_','/api/packs?q=missing','/api/packs?sort=popular&page=1','/api/packs?page=2','/api/packs?page=0','/api/packs?page=abc'])await compare(route);});
  await t.test('old cookie hashes, phone flags, blocked and expired sessions work unchanged',async()=>{for(const raw of [null,token,adminToken,blockedToken,expired,'x'])await compare('/api/me',raw);});
  await t.test('private packs are hidden except to their owner and administrators',async()=>{for(const [id,raw]of [[publicId,null],[pendingId,null],[pendingId,token],[pendingId,adminToken],[pendingId,blockedToken]])await compare('/api/packs/'+id,raw);await compare('/api/packs?mine=1');await compare('/api/packs?mine=1',token);});
  await t.test('contact and real installer manifest match the source service',async()=>{
    await compare('/api/admin-contact');await compare('/api/downloads');
    for(const directory of [target])fs.writeFileSync(path.join(directory,'downloads/manifest.json'),JSON.stringify({items:[release,{file:'bad.exe',bytes:1},{platform:null,file:'bad.apk',bytes:1}]}));
    await compare('/api/downloads');
    for(const directory of [target])fs.writeFileSync(path.join(directory,'downloads/manifest.json'),JSON.stringify({schemaVersion:1,items:[release]}));
    for(const directory of [target]){const edit=new DatabaseSync(path.join(directory,'hub.sqlite'));edit.exec('UPDATE admin_contact SET revision=1.5');edit.close();}
    await compare('/api/admin-contact');
    for(const directory of [target]){const edit=new DatabaseSync(path.join(directory,'hub.sqlite'));edit.exec('UPDATE admin_contact SET revision=2');edit.close();}
  });
  await t.test('download status does not charge; real files and installer HEAD preserve bytes and headers',async()=>{
    await compare('/api/packs/'+publicId+'/download-status');
    for(const route of ['/api/packs/'+publicId+'/download','/media/'+imageId,'/download/files/'+release.file]){
      const expected=frozen.downloads.find(i=>i.route===route);assert.ok(expected);const response=await get(javaOrigin,route);assert.equal(response.status,expected.status,route);for(const [name,value] of Object.entries(expected.headers))assert.equal(response.headers.get(name),value,route+': '+name);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(expected.base64,'base64'));
    }
    const head=await fetch(javaOrigin+'/download/files/'+release.file,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  });
  await t.test('unknown files and API routes fail without exposing private paths',async()=>{for(const route of ['/download/files/manifest.json','/download/files/other.exe','/api/packs/not-an-id','/media/'+randomUUID(),'/api/unknown'])assert.equal((await get(javaOrigin,route)).status,404,route);});
  await t.test('concurrent downloads reserve the site budget atomically and counts reflect success',async()=>{
    const before=new DatabaseSync(path.join(target,'hub.sqlite'));before.exec('DELETE FROM traffic');before.prepare('UPDATE packs SET downloads=0 WHERE id=?').run(publicId);const period=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());before.prepare('INSERT INTO traffic VALUES (?,?)').run(period,900);before.close();
    const results=await Promise.all(Array.from({length:12},()=>get(javaOrigin,'/download/files/'+release.file)));
    const succeeded=results.filter(response=>response.status===200).length;
    assert.equal(succeeded,Math.floor(100/release.bytes));
    for(const response of results){assert.ok([200,429].includes(response.status));await response.arrayBuffer();}
    const after=new DatabaseSync(path.join(target,'hub.sqlite'));assert.equal(after.prepare("SELECT bytes FROM traffic WHERE length(period)=7").get().bytes,900+succeeded*release.bytes);after.exec('UPDATE traffic SET bytes=999');after.close();
    assert.equal((await get(javaOrigin,'/api/packs/'+publicId+'/download')).status,429);
    const final=new DatabaseSync(path.join(target,'hub.sqlite'));assert.equal(final.prepare('SELECT downloads FROM packs WHERE id=?').get(publicId).downloads,0);final.close();
  });
  await t.test('account quota rejection rolls back site traffic and pack counters in the same transaction',async()=>{
    const control=new DatabaseSync(path.join(target,'hub.sqlite'));control.exec('DELETE FROM traffic; DELETE FROM cloud_traffic;');
    control.prepare('INSERT INTO cloud_accounts(user_id,limits_json) VALUES (?,?)').run(author,JSON.stringify({storageBytes:null,dailyTrafficBytes:0,monthlyTrafficBytes:null}));control.close();
    const response=await get(javaOrigin,'/api/packs/'+publicId+'/download',token);assert.equal(response.status,429);
    const check=new DatabaseSync(path.join(target,'hub.sqlite'));assert.equal(check.prepare('SELECT COUNT(*) AS n FROM traffic').get().n,0);assert.equal(check.prepare('SELECT COUNT(*) AS n FROM cloud_traffic').get().n,0);assert.equal(check.prepare('SELECT downloads FROM packs WHERE id=?').get(publicId).downloads,0);check.close();
  });
  await t.test('the approved UI loads only own assets and reflects actual migration capabilities',async()=>{
    const html=await(await get(javaOrigin,'/')).text();assert.ok(html.includes('发现题库'));assert.ok(!html.includes('demoRole'));assert.ok(!html.includes('fonts.googleapis'));assert.ok(!html.includes('>wgs<'));
    for(const route of ['/hub.js','/catalog-view.mjs','/hub.css','/admin-contact.js']){const response=await get(javaOrigin,route);assert.equal(response.status,200,route);if(route.endsWith('.mjs'))assert.match(response.headers.get('content-type'),/javascript/);}
    const value=await(await get(javaOrigin,'/api/java/capabilities')).json();assert.equal(value.phase,'hub-feature-parity');assert.ok(value.native.includes('auth-write'));assert.ok(value.native.includes('publishing'));assert.ok(value.native.includes('review'));assert.ok(value.pending.includes('production-cutover'));
  });
  assert.equal(requestIndex,frozen.requests.length,'All frozen reference requests must be checked');
});
