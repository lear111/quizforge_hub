import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createPracticeApp} from '../practice/server/app.mjs';

const runtime=process.env.QFH_TEST_RUNTIME||fileURLToPath(new URL('../.runtime/web-sync-20261027-network',import.meta.url));
const enabled=fs.existsSync(path.join(runtime,'core/web/listening/network-audio.js'));
const alice={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic Alice',email:'alice@example.test',admin:1};
const bob={id:'22222222-2222-4222-8222-222222222222',name:'Synthetic Bob',email:'bob@example.test',admin:0};
async function fixture(t){
  const parent=fileURLToPath(new URL('../.temp/network-listening-tests/',import.meta.url));fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'host-'));
  let app,origin;
  const open=async()=>{app=await createPracticeApp({dataDir:dir,cloudRuntimeDir:runtime,practiceHome:true,identityProvider:async req=>req.headers.cookie==='synthetic=alice'?alice:req.headers.cookie==='synthetic=bob'?bob:null,cloud:{defaults:{storageBytes:128*1024**2,dailyTrafficBytes:32*1024**2,monthlyTrafficBytes:32*1024**2}}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${app.server.address().port}`;};
  await open();
  t.after(async()=>{app.server.closeAllConnections();await app.close();assert.equal(path.dirname(dir),parent.slice(0,-1));fs.rmSync(dir,{recursive:true,force:true});});
  const request=(route,user='alice',options={})=>fetch(origin+route,{redirect:'manual',...options,headers:{Cookie:'synthetic='+user,...options.headers}});
  const post=(route,body,user='alice',headers={})=>request(route,user,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const json=async promise=>{const response=await promise,body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  return {get app(){return app;},dir,request,post,json,async restart(){app.server.closeAllConnections();await app.close();await open();}};
}

test('cloud host page permits anonymous HTTPS audio and Blob playback while preserving private pages and iframe network isolation',{skip:!enabled},async t=>{
  const f=await fixture(t),entry=await f.request('/'),page=entry.headers.get('location');assert.match(page,/^\/cloud\/practice\//);
  const response=await f.request(page);assert.equal(response.status,200);
  const policy=response.headers.get('content-security-policy');assert.match(policy,/connect-src 'self' https:/);assert.match(policy,/media-src 'self' blob:/);
  assert.equal((await f.request(page,'')).status,303);assert.equal((await f.request(page,'bob')).status,404);
  const loader=await f.request(page+'listening/network-audio.js');assert.equal(loader.status,200);const source=await loader.text();
  assert.match(source,/credentials:'omit'/);assert.match(source,/referrerPolicy:'no-referrer'/);assert.doesNotMatch(source,/X-QuizForge|Authorization:|accessToken/);
  const frame=await (await f.request(page+'bridge/frame.js')).text();assert.match(frame,/connect-src 'none'/);
});

test('network listening survives authenticated cloud import/export, independent copies, exam snapshots and restart without server-side audio fetch',{skip:!enabled},async t=>{
  const originalFetch=globalThis.fetch;let remoteReads=0;
  t.mock.method(globalThis,'fetch',async(address,options)=>{if(String(address).startsWith('https://audio.example.invalid/')){remoteReads++;throw new Error('Host must not fetch media');}return originalFetch(address,options);});
  const f=await fixture(t);await f.request('/');const item=f.app.cloudLibrary.list(alice.id)[0],bank=item.banks[0],root=f.app.cloudLibrary.location(alice.id,item.id),bankFile=path.join(root,'question-banks',bank.path,'bank.json');
  const raw=JSON.parse(fs.readFileSync(bankFile));const url='https://audio.example.invalid/cet-v1.mp3';raw.listening={materials:[{id:'exam',title:'Synthetic network material',url}],examMaterialId:'exam'};raw.questions[0].listening={materialId:'exam'};fs.writeFileSync(bankFile,JSON.stringify(raw));
  const scope='/api/cloud/practice/'+item.id,collection='/api/collections/bank/'+bank.id,base=scope+collection,q=base+'/questions/'+raw.questions[0].id;
  const overview=await f.json(f.request(base));assert.equal(overview.listening.materials[0].url,url);assert.equal((await f.request(base+'/listening/exam')).status,422);assert.equal((await f.request(base,'bob')).status,404);
  const state=await f.json(f.request(q));const saved=await f.json(f.post(q+'/actions',{requestId:randomUUID(),revision:state.state.revision,contentVersion:state.stamp.contentVersion,action:'draft',data:{answer:{selectedOptionId:raw.questions[0].data.correctOptionId}}}));assert.equal(saved.state.status,'draft');
  const started=await f.json(f.post(base+'/exams',{requestId:randomUUID(),durationMinutes:null}));const exam=scope+'/api/collections/exam/'+started.id;assert.equal((await f.json(f.request(exam))).listening.materials[0].url,url);
  const exported=await f.post('/api/cloud/library/'+item.id+'/export-selection',{bank:bank.path});assert.equal(exported.status,200);const bytes=Buffer.from(await exported.arrayBuffer());
  const imported=await f.json(f.post(scope+'/api/library/import',bytes,'alice',{'Content-Type':'application/vnd.quizforge.qbank','X-QuizForge-Filename':encodeURIComponent('网络听力.qbank')}));const copy=imported.catalog.banks.find(row=>row.id!==bank.id);assert.ok(copy);
  assert.equal((await f.json(f.request(scope+'/api/collections/bank/'+copy.id))).listening.materials[0].url,url);
  await f.restart();assert.deepEqual((await f.json(f.request(q))).state.answer,saved.state.answer);assert.equal((await f.json(f.request(exam))).listening.materials[0].url,url);assert.equal(remoteReads,0);
});
