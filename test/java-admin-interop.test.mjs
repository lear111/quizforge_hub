import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {createPracticeApp as createApp} from '../practice/server/app.mjs';
import {HubLogin} from '../practice/server/cloud/hub-login.mjs';
import {createPracticeAdminBridge} from '../practice/server/admin/bridge.mjs';
import {loadRuntime} from '../practice/server/cloud/runtime.mjs';

const jar=process.env.HUB_JAVA_JAR,runtimePath=process.env.QFH_TEST_RUNTIME||fileURLToPath(new URL('../.runtime/web-current',import.meta.url));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const stop=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('Java moderation uses retained Node practice review snapshots, whitelist and stable account quotas', {skip:!jar||!existsSync(runtimePath)},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qfh-java-review-')),data=path.join(root,'java'),practiceDir=path.join(root,'practice');
  const reserve=http.createServer(),javaPort=await listen(reserve);await stop(reserve);
  const origin='http://127.0.0.1:'+javaPort,publicOrigin='https://hub.example.test';
  const login=new HubLogin({practiceOrigin:'https://practice.example.test',hubOrigin:publicOrigin,authPort:javaPort,cookieName:'qfh_java_test'});
  const practice=await createApp({dataDir:practiceDir,cloudEnabled:true,cloudRuntimeDir:runtimePath,identityProvider:async()=>null});
  const bridge=createPracticeAdminBridge({library:practice.cloudLibrary,reviews:practice.reviewPackages,authenticate:token=>login.identity(token),hubPort:javaPort,hubCookieName:'qfh_java_test'});
  const bridgePort=await listen(bridge.server);
  let child,exit;
  t.after(async()=>{await stop(bridge.server);if(child&&child.exitCode===null){child.kill();await exit;}await practice.close();await fs.rm(root,{recursive:true,force:true});});
  child=spawn(process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java',['-Xmx192m','-jar',path.resolve(jar),'--server.port='+javaPort,'--hub.data-dir='+data],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ADMIN_ENABLED:'true',PRACTICE_BRIDGE_ENABLED:'true',PRACTICE_ADMIN_PORT:String(bridgePort),HUB_COOKIE_NAME:'qfh_java_test',OFFICIAL_AI_MASTER_KEY:Buffer.alloc(32).toString('base64'),PUBLIC_ORIGIN:publicOrigin,REVIEW_EMAIL:'',TENCENT_SES_ENABLED:'false'}});
  exit=once(child,'exit');let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const deadline=Date.now()+60000;while(!output.includes('Tomcat started on port')&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));assert.ok(output.includes('Tomcat started on port'),'Java did not start: '+output.slice(-2500));
  const people={};const db=new DatabaseSync(path.join(data,'hub.sqlite'));
  for(const role of ['admin','owner']){const id=randomUUID(),token=randomBytes(32).toString('hex');people[role]={id,token};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,role+'@example.test',role,'!synthetic-disabled',role==='admin'?1:0,new Date().toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token),id,Date.now()+3600000);}db.close();
  const request=(route,body,role='admin',method=body===undefined?'GET':'POST')=>fetch(origin+route,{method,redirect:'manual',headers:{Origin:publicOrigin,...(role?{Cookie:'qfh_java_test='+people[role].token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
  await t.test('configured cookie authenticates the same Java identity over fixed loopback',async()=>{assert.equal((await login.identity(people.admin.token)).id,people.admin.id);assert.equal((await request('/api/admin/cloud/extensions',undefined,'owner')).status,403);const summary=await json(await request('/api/admin/overview'));assert.equal(typeof summary.cloud.pendingExtensions,'number');});
  const runtime=await loadRuntime(runtimePath),content=path.join(root,'package');await fs.mkdir(content);const archive=new runtime.LibraryArchive(content,new runtime.ResourceStore(content));await archive.unzip(path.join(runtimePath,'basic-demo.qbank'),content);
  const extensions=runtime.scanExtensions(path.join(content,'extensions')),manifest=JSON.parse(await fs.readFile(path.join(extensions[0],'manifest.json'),'utf8'));
  await fs.writeFile(path.join(extensions[0],manifest.rules),'throw new Error("REVIEW_MUST_NOT_EXECUTE");');
  const file=path.join(root,'synthetic.qbank');await archive.zip(content,file);const bytes=await fs.readFile(file);
  const form=new FormData();for(const [key,value] of Object.entries({title:'Synthetic review',summary:'Synthetic only',description:'Synthetic review content',version:'1.0',rights:'yes'}))form.set(key,value);form.set('archive',new Blob([bytes]),'synthetic.qbank');
  const uploaded=await fetch(origin+'/api/packs',{method:'POST',headers:{Origin:publicOrigin,Cookie:'qfh_java_test='+people.owner.token},body:form});assert.equal(uploaded.status,201,await uploaded.clone().text());const {pack}=await uploaded.json();
  let inspected;
  await t.test('inspection freezes code as inert text and publication requires explicit review',async()=>{
    assert.equal((await request('/api/admin/packs/'+pack.id+'/decision',{decision:'approved',reason:'synthetic',revision:1,codeReviewed:true})).status,409);
    inspected=await json(await request('/api/admin/packs/'+pack.id+'/inspect',{}));assert.equal(inspected.item.status,'pending');assert.ok(inspected.item.extensions.length>0);
    const extension=inspected.item.extensions.find(e=>e.files.some(f=>f.path===manifest.rules));const code=await json(await request('/api/admin/cloud/submissions/'+inspected.item.id+'/file?'+new URLSearchParams({extension:extension.digest,path:manifest.rules})));assert.match(code.text,/REVIEW_MUST_NOT_EXECUTE/);
    assert.equal((await request('/api/admin/packs/'+pack.id+'/decision',{decision:'approved',reason:'synthetic',revision:1})).status,400);
    await json(await request('/api/admin/packs/'+pack.id+'/decision',{decision:'approved',reason:'synthetic review completed',revision:1,codeReviewed:true}));
    assert.equal((await request('/api/packs/'+pack.id,undefined,null)).status,200);const check=new DatabaseSync(path.join(data,'hub.sqlite'));assert.equal(check.prepare('SELECT status FROM pack_cloud_approvals WHERE pack_id=?').get(pack.id).status,'approved');assert.equal(check.prepare('SELECT COUNT(*) n FROM pack_reviews WHERE pack_id=?').get(pack.id).n,1);check.close();
  });
  await t.test('administrator uploads known code directly and confirms new code without leaving the upload flow',async()=>{
    const upload=async(buffer,reviewed=false)=>{const data=new FormData();for(const [key,value] of Object.entries({title:'Administrator synthetic',summary:'Synthetic only',description:'Synthetic administrator publication',version:'1.0',rights:'yes'}))data.set(key,value);if(reviewed)data.set('codeReviewed','yes');data.set('archive',new Blob([buffer]),'admin-synthetic.qbank');const response=await fetch(origin+'/api/packs',{method:'POST',headers:{Origin:publicOrigin,Cookie:'qfh_java_test='+people.admin.token},body:data});assert.equal(response.status,201,await response.clone().text());return response.json();};
    const control=new DatabaseSync(path.join(data,'hub.sqlite'));const queued=()=>control.prepare('SELECT generation FROM review_mail_state WHERE id=1').get().generation;const before=queued();
    try{
      const known=await upload(bytes);assert.equal(known.pack.status,'approved');assert.equal(known.publication.state,'published');assert.equal(queued(),before);
      await fs.appendFile(path.join(extensions[0],manifest.rules),'\n// new code revision for confirmation');const modified=path.join(root,'admin-modified.qbank');await archive.zip(content,modified);
      const unknown=await upload(await fs.readFile(modified));assert.equal(unknown.pack.status,'pending');assert.equal(unknown.publication.state,'code-review-required');assert.equal((await request('/api/packs/'+unknown.pack.id,undefined,null)).status,404);
      const done=await json(await request('/api/packs/'+unknown.pack.id+'/publish',{revision:unknown.pack.revision,codeReviewed:true}));assert.equal(done.pack.status,'approved');assert.equal(queued(),before);
      const receipt=control.prepare('SELECT revision,sha256,status FROM pack_cloud_approvals WHERE pack_id=?').get(done.pack.id);assert.equal(receipt.revision,done.pack.revision);assert.equal(receipt.sha256,done.pack.archive.sha256);assert.equal(receipt.status,'approved');
      for(const value of [known,done])assert.equal((await request('/api/packs/'+value.pack.id,undefined,null)).status,200);
    }finally{control.close();}
  });
  await t.test('private delivery resolves a phone-only recipient through Java before their first practice visit',async()=>{
    const recipient=randomUUID(),phone='+8613800138000',control=new DatabaseSync(path.join(data,'hub.sqlite'));
    try{control.exec('PRAGMA foreign_keys=ON');control.prepare('INSERT INTO users VALUES(?,NULL,?,?,0,?)').run(recipient,'Synthetic phone recipient','!disabled',new Date().toISOString());control.prepare('INSERT INTO user_phones VALUES(?,?,0)').run(recipient,phone);control.prepare('INSERT INTO unverified_contacts VALUES(?,?,?)').run(recipient,'phone',phone);}finally{control.close();}
    assert.equal(practice.db.prepare('SELECT 1 FROM users WHERE id=?').get(recipient),undefined);
    const delivery=await fetch(origin+'/api/admin/cloud/users/'+recipient+'/import',{method:'POST',headers:{Origin:publicOrigin,Cookie:'qfh_java_test='+people.admin.token,'Content-Type':'application/octet-stream','X-QuizForge-Filename':encodeURIComponent('synthetic-basic.qbank')},body:await fs.readFile(path.join(runtimePath,'basic-demo.qbank'))});
    assert.equal(delivery.status,201,await delivery.clone().text());const item=(await delivery.json()).item;assert.ok(item.id);
    assert.equal(practice.db.prepare('SELECT email FROM users WHERE id=?').get(recipient).email,null);assert.equal(practice.db.prepare('SELECT phone FROM user_phones WHERE user_id=?').get(recipient).phone,phone);assert.equal(practice.db.prepare('SELECT contact FROM unverified_contacts WHERE user_id=?').get(recipient).contact,phone);
    assert.ok(practice.cloudLibrary.list(recipient).some(value=>value.id===item.id));assert.equal(practice.db.prepare('SELECT user_id FROM cloud_imports WHERE id=?').get(item.id).user_id,recipient);
  });
  await t.test('whitelist revocation invalidates package cloud approval without rewriting published bytes',async()=>{
    const digest=inspected.item.extensions[0].digest;await json(await request('/api/admin/cloud/extensions/revoke',{digest,reason:'synthetic revocation'}));const check=new DatabaseSync(path.join(data,'hub.sqlite'));assert.equal(check.prepare('SELECT status FROM pack_cloud_approvals WHERE pack_id=?').get(pack.id).status,'revoked');assert.equal(check.prepare('SELECT sha256 FROM files WHERE id=?').get(pack.archive.id).sha256,sha(bytes));check.close();
  });
  await t.test('resource administration synchronizes stable identity through Java profile lookup',async()=>{
    await json(await request('/api/admin/cloud/users/'+people.owner.id+'/limits',{storageBytes:32*1048576,dailyTrafficBytes:16*1048576,reason:'synthetic limits'},'admin','PUT'));
    const users=await json(await request('/api/admin/users'));const owner=users.users.find(u=>u.id===people.owner.id);assert.equal(owner.resources.limits.storageBytes,32*1048576);assert.equal(practice.db.prepare('SELECT id FROM users WHERE id=?').get(people.owner.id).id,people.owner.id);
  });
  await t.test('practice login handoff and central logout use Java cookies with one-time browser state',async sub=>{
    const raw=randomBytes(32).toString('hex'),control=new DatabaseSync(path.join(data,'hub.sqlite'));control.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(raw),people.owner.id,Date.now()+3600000);control.close();
    const surface=http.createServer(async(req,res)=>{try{if(await login.handle(req,res,new URL(req.url,'http://localhost')))return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await login.resolve(req)));}catch(error){req.resume();res.writeHead(error.status||503).end('Rejected');}}),port=await listen(surface);sub.after(()=>stop(surface));
    const send=(route,host,headers={},method='GET')=>new Promise((resolve,reject)=>{const outgoing=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:host,...headers}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString()}));});outgoing.on('error',reject);outgoing.end();});
    const first=await send('/auth/hub','practice.example.test'),verifier=first.headers['set-cookie'][0].split(';')[0],requestKey=new URL(first.headers.location).searchParams.get('request');assert.equal(first.status,303);
    const allowed=await send('/practice-auth/authorize?request='+requestKey,'hub.example.test',{Cookie:'qfh_java_test='+raw});assert.equal(allowed.status,303);const next=new URL(allowed.headers.location);
    const completed=await send(next.pathname+next.search,'practice.example.test',{Cookie:verifier});assert.equal(completed.status,303);const practiceCookie=completed.headers['set-cookie'].find(value=>value.startsWith('__Host-qfh_practice=')).split(';')[0];assert.equal(JSON.parse((await send('/whoami','practice.example.test',{Cookie:practiceCookie})).text).id,people.owner.id);
    assert.equal((await send(next.pathname+next.search,'practice.example.test',{Cookie:verifier})).status,400);
    assert.equal((await send('/auth/logout','practice.example.test',{Cookie:practiceCookie,Origin:'https://practice.example.test'},'POST')).status,200);assert.equal(await login.identity(raw),null);assert.equal((await login.identity(people.owner.token)).id,people.owner.id);
  });
  await t.test('Node and Java exchange legacy AES-GCM redeem-code ciphertext without exposing the master key',async()=>{
    const created=await request('/api/admin/ai-codes',{count:1,amount:100,expires:Date.now()+86400000,note:'synthetic interop'});assert.equal(created.status,201);const item=(await created.json()).items[0];const control=new DatabaseSync(path.join(data,'hub.sqlite'));
    try{const stored=control.prepare('SELECT code_cipher FROM ai_redeem_codes WHERE id=?').get(item.id).code_cipher,bytes=Buffer.from(stored,'base64'),aad=Buffer.from('quizforge-redeem-code-v1'),master=Buffer.alloc(32);
      const decipher=createDecipheriv('aes-256-gcm',master,bytes.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(12,28));assert.equal(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString(),item.code);
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(aad);const payload=Buffer.concat([cipher.update(item.code),cipher.final()]),nodeCipher=Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64');control.prepare('UPDATE ai_redeem_codes SET code_cipher=? WHERE id=?').run(nodeCipher,item.id);
      const listed=await json(await request('/api/admin/ai-codes'));assert.equal(listed.items.find(row=>row.id===item.id).code,item.code);assert.equal(listed.items.find(row=>row.id===item.id).full,true);
    }finally{control.close();}
  });
  await t.test('withdrawal removes public access and all requests leave no temporary upload files',async()=>{
    await json(await request('/api/admin/packs/'+pack.id+'/unpublish',{reason:'synthetic withdrawal'}));assert.equal((await request('/api/packs/'+pack.id,undefined,null)).status,404);const audit=await json(await request('/api/admin/audit'));assert.ok(audit.items.some(i=>i.action==='pack-approved'));const entries=await fs.readdir(path.join(data,'admin-work')).catch(()=>[]);assert.deepEqual(entries,[]);
  });
});
