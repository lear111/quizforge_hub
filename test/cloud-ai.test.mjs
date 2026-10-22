import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { CloudAccounts } from '../cloud/accounts.mjs';
import { CloudLibrary } from '../cloud/library.mjs';
import { gradeDirect, testGradingModel } from '../public/cloud/vault.js';

const snapshot = (process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-current', import.meta.url)));
const alice = '11111111-1111-4111-8111-111111111111', bob = '22222222-2222-4222-8222-222222222222';
const page = '44444444-4444-4444-8444-444444444444';
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
async function fixture(t, history = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qfh-cloud-ai-')), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,admin INTEGER,created TEXT)');
  for (const id of [alice,bob]) db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id,id,id+'@example.test',id===alice?1:0,'');
  const accounts = new CloudAccounts(db), library = await CloudLibrary.create(db, accounts, root, snapshot), item = await library.demo(alice);
  t.after(async () => { await library.close(); db.close(); fs.rmSync(root, {recursive:true,force:true}); });
  if (!history) {
    const visit = directory => { for (const entry of fs.readdirSync(directory,{withFileTypes:true})) { const file=path.join(directory,entry.name); if(entry.isDirectory())visit(file); else if(entry.name==='bank.json'){const value=JSON.parse(fs.readFileSync(file));value.features.history=false;fs.writeFileSync(file,JSON.stringify(value));} } };
    visit(path.join(library.location(alice,item.id),'question-banks'));
  }
  let serial = 0;
  const raw = async (route, body, flags = 'manual', owner = alice, client = page) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method: body === undefined ? 'GET':'POST', headers: {'content-type':'application/json','x-quizforge-practice-session':client,'x-quizforge-cloud-ai':flags} });
    const response = await library.practice.api(owner, item.id, route, request); return { status: response.status, body: JSON.parse(response.bytes) };
  };
  const api = async (...args) => { const response = await raw(...args); assert.equal(response.status,200,JSON.stringify(response.body)); return response.body; };
  const base = '/api/collections/bank/'+item.banks[0].id;
  const action = async (route, kind, data, flags='manual') => { const current=await api(route); return api(route+'/actions',{requestId:'cloud-ai-action-'+(++serial),revision:current.state.revision,contentVersion:current.stamp.contentVersion,action:kind,data},flags); };
  const submit = (route,responses,flags) => action(route,'submit',{answer:{responses}},flags);
  const start = async (route,targetId) => { const current=await api(route);return api(route+'/ai/grade',{requestId:'cloud-ai-start-'+(++serial),targetId,contentVersion:current.stamp.contentVersion}); };
  const claim = task => api('/api/cloud-ai/claim',{taskId:task.taskId});
  const result = (task, lease, score=4) => ({taskId:task.taskId,lease:lease.lease,result:{output:JSON.stringify({score,feedback:'合成模型反馈：说明基本作用和注意事项。'}),provider:'openai-compatible',model:'synthetic-model',responseId:'synthetic-response',usage:{total_tokens:30}}});
  return {library,accounts,item,root,base,api,raw,action,submit,start,claim,result};
}

test('cloud AI browser result reuses native target scoring, idempotency, ownership, stale guards and quota rollback', {skip:!fs.existsSync(snapshot)}, async t => {
  const f=await fixture(t), q=f.base+'/questions/short-sample-text';
  await f.submit(q,{cache:doc('缓存减少重复读取，需要注意数据过期。')});
  assert.equal((await f.raw(q+'/ai/grade',{requestId:'disabled-ai-start',targetId:'cache'},'off')).status,409);
  const task=await f.start(q,'cache'); assert.equal(task.status,'queued'); assert.ok(task.cloudAiPending.length);
  assert.equal(JSON.stringify(task).includes('cloudDelivery'),false);
  const lease=await f.claim(task); assert.match(JSON.stringify(lease.input),/缓存/); assert.equal(JSON.stringify(lease).includes('browser.invalid'),false);
  assert.equal((await f.raw('/api/cloud-ai/claim',{taskId:task.taskId})).status,409);
  assert.equal((await f.raw('/api/cloud-ai/result',f.result(task,lease), 'manual',alice,'55555555-5555-4555-8555-555555555555')).status,404);
  await assert.rejects(f.raw('/api/cloud-ai/result',f.result(task,lease),'manual',bob),/不存在/);
  const payload=f.result(task,lease), usage=f.accounts.status(alice).usage.storageBytes;
  f.accounts.updateLimits(alice,alice,{storageBytes:usage,dailyTrafficBytes:null,monthlyTrafficBytes:null},'验证 AI 保存额度');
  await assert.rejects(f.api('/api/cloud-ai/result',payload),/存储额度/);
  assert.equal((await f.api(q)).state.result.score,0);
  f.accounts.updateLimits(alice,alice,{storageBytes:null,dailyTrafficBytes:null,monthlyTrafficBytes:null},'恢复额度');
  assert.equal((await f.api('/api/cloud-ai/result',payload)).status,'confirmed');
  let saved=await f.api(q); assert.equal(saved.state.result.score,4); assert.equal(saved.state.result.aiAssessments.cache.model,'synthetic-model'); const revision=saved.state.revision;
  assert.equal((await f.api('/api/cloud-ai/result',payload)).status,'confirmed'); assert.equal((await f.api(q)).state.revision,revision);
  assert.equal((await f.raw('/api/cloud-ai/result',f.result(task,lease,3))).status,409);
  const second=await f.start(q,'cache'), secondLease=await f.claim(second);
  await f.action(q,'review',{review:{targetId:'cache',score:2,feedback:'人工调整'}});
  assert.equal((await f.raw('/api/cloud-ai/result',f.result(second,secondLease,5))).status,409); assert.equal((await f.api(q)).state.result.score,2);
  const interrupted=await f.start(q,'cache'), ai=f.library.practice.sessions.get(f.item.id).ai;
  const collection=await ai.library.collection('bank',f.item.banks[0].id), record=ai.scoped(collection,collection.question('short-sample-text'),interrupted.taskId);
  record.value.snapshot.cloudDelivery.deadline=0;ai.persist(record);
  const expired=await f.raw(q+'/ai/current?targetId=cache',undefined,'manual',alice,'55555555-5555-4555-8555-555555555555');assert.equal(expired.body.task.status,'failed');assert.equal(expired.body.task.error.code,'AI_INTERRUPTED');
  // No credentials or provider transport ever reach the host's profile store.
  assert.equal(fs.existsSync(path.join(f.library.location(alice,f.item.id),'.state/ai/profile.json')),false);
});

test('automatic multi-target grading, explicit retry, image inputs and exam hand-in use browser delivery', {skip:!fs.existsSync(snapshot)}, async t => {
  const f=await fixture(t), raw=JSON.parse(fs.readFileSync(path.join(snapshot,'basic-content/question-banks/基础题型/基础题型展示/bank.json')));
  const material=raw.questions.find(q=>q.id==='short-sample-material'), responses=Object.fromEntries(material.data.parts.map(p=>[p.id,doc('合成测试作答')])), q=f.base+'/questions/'+material.id;
  const submitted=await f.submit(q,responses,'auto'); assert.equal(submitted.cloudAiPending.length,material.data.parts.length);
  for(const task of submitted.cloudAiPending){const lease=await f.claim(task);assert.equal((await f.api('/api/cloud-ai/result',f.result(task,lease,1))).status,'confirmed');}
  const saved=await f.api(q); assert.equal(Object.keys(saved.state.result.aiAssessments).length,material.data.parts.length); assert.equal(saved.state.result.score,material.data.parts.length);
  const target=material.data.parts[0].id, task=await f.start(q,target), lease=await f.claim(task);
  assert.equal((await f.api('/api/cloud-ai/fail',{taskId:task.taskId,lease:lease.lease,code:'AI_AUTH'})).status,'failed');
  const retry=await f.api(q+'/ai/tasks/'+task.taskId+'/retry',{requestId:'explicit-retry-once'}); assert.notEqual(retry.taskId,task.taskId); const retried=await f.claim(retry); await f.api('/api/cloud-ai/result',f.result(retry,retried,2));
  const image=f.base+'/questions/short-sample-image-math'; await f.submit(image,{area:doc('面积是6平方厘米。')}); const imageTask=await f.start(image,'area'), imageLease=await f.claim(imageTask); assert.match(JSON.stringify(imageLease.input),/data:image\/png;base64/);
  await f.api('/api/cloud-ai/fail',{taskId:imageTask.taskId,lease:imageLease.lease,code:'AI_VISION_UNSUPPORTED'});
  const exam=await f.api(f.base+'/exams',{requestId:'cloud-ai-exam-start',durationMinutes:null}), examBase='/api/collections/exam/'+exam.id, examQ=examBase+'/questions/short-sample-text';
  await f.action(examQ,'draft',{answer:{responses:{cache:doc('考试中的缓存说明。')}}});
  const handIn=await f.api(examBase+'/exam',{},'auto'); assert.ok(handIn.cloudAiPending.length);
  for(const queued of handIn.cloudAiPending){const delivery=await f.claim(queued); await f.api('/api/cloud-ai/result',f.result(queued,delivery,3));}
  assert.equal((await f.api(examBase+'/exam')).status,'completed'); assert.equal((await f.api(examQ)).state.result.score,3);
});

test('browser transport sends Key only to HTTPS model, redacts echoes, rejects refusal/oversize/vision and never retries billing', async () => {
  const profile={baseUrl:'https://model.example.test/v1',model:'synthetic',apiKey:'synthetic-secret'}, input={messages:[{role:'system',content:'score'},{role:'user',content:'answer'}]}; let calls=0;
  const result=await gradeDirect(profile,input,async(url,options)=>{calls++;assert.equal(url,profile.baseUrl+'/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+profile.apiKey);assert.equal(options.body.includes(profile.apiKey),false);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return Response.json({id:'synthetic',choices:[{finish_reason:'stop',message:{content:JSON.stringify({score:3,feedback:profile.apiKey})}}]});});
  assert.equal(calls,1);assert.equal(JSON.stringify(result).includes(profile.apiKey),false);assert.match(result.output,/redacted/);
  await assert.rejects(gradeDirect(profile,input,async()=>{calls++;return new Response('raw secret', {status:401});}),{code:'AI_AUTH'});assert.equal(calls,2);
  await assert.rejects(gradeDirect(profile,{messages:[{role:'system',content:'score'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}]}),{code:'AI_VISION_UNSUPPORTED'});
  await assert.rejects(gradeDirect(profile,input,async()=>Response.json({choices:[{finish_reason:'length',message:{content:'truncated'}}]})),{code:'AI_OUTPUT_INVALID'});
  await assert.rejects(gradeDirect(profile,input,async()=>new Response('x'.repeat(2*1024**2+1))),{code:'AI_OUTPUT_INVALID'});
});

test('cloud AI without history stays page scoped and result retries remain idempotent', {skip:!fs.existsSync(snapshot)}, async t => {
  const f=await fixture(t,false), q=f.base+'/questions/short-sample-text';
  await f.submit(q,{cache:doc('仅当前页面的缓存答案。')});
  const task=await f.start(q,'cache'), lease=await f.claim(task), result=f.result(task,lease);
  assert.equal((await f.api('/api/cloud-ai/result',result)).status,'confirmed');
  const saved=await f.api(q);assert.equal(saved.state.result.score,4);
  assert.equal((await f.api('/api/cloud-ai/result',result)).status,'confirmed');assert.equal((await f.api(q)).state.revision,saved.state.revision);
  const other=await f.raw(q,undefined,'manual',alice,'55555555-5555-4555-8555-555555555555');assert.equal(other.body.state.answer,null);
});

test('browser model diagnostics makes bounded probes and enables vision only for a recognized image', async () => {
  let calls=0;const profile={baseUrl:'https://model.example.test/v1',model:'synthetic',apiKey:'synthetic-secret'},challenge={expected:'ABC123',dataUrl:'data:image/png;base64,AA=='};
  const mock=recognized=>async(_url,options)=>{calls++;const input=JSON.parse(options.body),text=JSON.stringify(input.messages);const output=text.includes('Reply with OK')?'OK':JSON.stringify({score:text.includes('评分格式测试')?2:0,feedback:text.includes('评分格式测试')?'评分格式通过':recognized?'ABC123':'wrong'});return Response.json({choices:[{finish_reason:'stop',message:{content:output}}]});};
  assert.equal((await testGradingModel(profile,challenge,mock(true))).vision,true);assert.equal(calls,3);
  assert.equal((await testGradingModel(profile,challenge,mock(false))).vision,false);assert.equal(calls,6);
});
