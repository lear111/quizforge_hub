import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';
import {ordinaryPracticeAsset} from '../practice/server/cloud/practice-ui.mjs';
const clientSource=fs.readFileSync(new URL('../practice/public/cloud/ai-client.js',import.meta.url),'utf8');
const prefix='/api/cloud/practice/11111111-1111-4111-8111-111111111111',route='/api/collections/bank/bank/questions/q',task={taskId:'a'.repeat(64),targetId:'blank',status:'queued'};
function client(){const document=new EventTarget();const sandbox={document,CustomEvent,Event,structuredClone,Date,AbortSignal,setTimeout,clearTimeout,fetch(){throw Error('initial task lookup must not use network');}};vm.runInNewContext(clientSource.replace(/export /g,'')+';globalThis.client={observeCloudAi,takeCloudAiTask,setCloudAiPrefs,cloudAiPreferencesReady,cloudAiHeaders};',sandbox);return sandbox.client;}
test('first task state is immediately available by workspace, question and target and consumed only once',()=>{
 const c=client();c.observeCloudAi({cloudAiStates:[{route,task}]},prefix,{});
 assert.equal(c.takeCloudAiTask(prefix+route,'other'),null);assert.equal(c.takeCloudAiTask('/api/cloud/practice/other'+route,'blank'),null);
 const value=c.takeCloudAiTask(prefix+route,'blank');assert.equal(value.status,'queued');assert.equal(value.taskId,task.taskId);assert.equal(c.takeCloudAiTask(prefix+route,'blank'),null);
});
test('a newer write and terminal results discard old initial display states',()=>{
 const c=client(),seed=()=>c.observeCloudAi({cloudAiStates:[{route,task}]},prefix,{});
 seed();c.observeCloudAi({state:{}},prefix,{},route+'/actions');assert.equal(c.takeCloudAiTask(prefix+route,'blank'),null);
 seed();c.observeCloudAi({taskId:task.taskId,status:'confirmed'},prefix,{});assert.equal(c.takeCloudAiTask(prefix+route,'blank'),null);
 seed();const value=c.takeCloudAiTask(prefix+route,'blank');value.status='failed';seed();assert.equal(c.takeCloudAiTask(prefix+route,'blank').status,'queued');
});
test('cloud requests can wait for the initial saved or default preferences',async()=>{
 const c=client();let ready=false;const pending=c.cloudAiPreferencesReady().then(()=>{ready=true;});await Promise.resolve();assert.equal(ready,false);
 c.setCloudAiPrefs({enabled:true,autoGrade:true,useOfficial:true,useCustom:false});await pending;assert.equal(ready,true);assert.equal(c.cloudAiHeaders()['X-QuizForge-Cloud-Ai'],'auto');
});
const runtime=process.env.QFH_TEST_RUNTIME;
test('normal question frame reads queued state before renderer readiness or a second API request', {skip:!runtime},async()=>{
 const source=ordinaryPracticeAsset('app.js',fs.readFileSync(path.join(runtime,'core/web/app.js'),'utf8'),prefix.replace('/api',''));
 const marker='onRequest:(method,args)=>{const target=pane.plugin===candidatePlugin?pane:next;';const start=source.indexOf(marker);assert.ok(start>=0);
 const end=source.indexOf(',onError:',start);assert.ok(end>start);const handler=source.slice(start+'onRequest:'.length,end);
 const c=client();c.observeCloudAi({cloudAiStates:[{route,task}]},prefix,{});let fallback=0;
 const sandbox={pane:{plugin:null,view:'practice'},next:{view:'practice',kind:'bank',id:'bank',questionId:'q'},candidatePlugin:{ready:new Promise(()=>{})},qid:'q',questionPath:()=>route,takeCloudAiTask:c.takeCloudAiTask,pageRequest(){fallback++;throw Error('network must not be required');},Promise};
 const request=vm.runInNewContext('('+handler+')',sandbox);const reply=await request('ai-task',{targetId:'blank'});assert.equal(reply.ok,true);assert.equal(reply.data.task.status,'queued');assert.equal(fallback,0);
 // Exercise the actual basic answer-area button renderer with the returned state.
 const extension=fs.readFileSync(new URL('../practice/vendor/web-basic-20261023/extensions/基础题型/简答题（答题区）/practice.js',import.meta.url),'utf8');const body=extension.slice(extension.indexOf('  function updateGrade('),extension.indexOf('  async function saveReview('));
 const button={},target={ai:button,result:{},value:{},slider:{},feedback:{}};
 vm.runInNewContext(body+';updateGrade("blank");',{targets:new Map([['blank',target]]),tasks:new Map([['blank',reply.data.task]]),context:{status:'submitted',question:{data:{parts:[{id:'blank',maxScore:5}]}},capabilities:{canAiGrade:true,canReview:true}},reviewDrafts:new Map(),answers:new Map([['blank',{}]]),areaEmpty:()=>false,resize(){}});
 assert.equal(button.disabled,true);assert.match(button.textContent,/评分中/);
});
