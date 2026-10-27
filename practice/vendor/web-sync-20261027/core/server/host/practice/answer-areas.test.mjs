import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {randomUUID} from 'node:crypto';
import {answerAreaModel} from '../../../shared/answer-area/1.0.0/model.js';
import {prepareAnswerAreas,renderAnswerArea} from './answer-areas.js';
import {ResourceStore,imageReferences} from '../resources/resources.js';
import {StateStore} from './state-store.js';
import {RuleEngine} from '../extensions/rule-engine.js';
import {Library} from '../library/library.js';
import {copyFixture,writeFixture} from '../../../test/fixtures/installed-library.mjs';
import {QuizForgeServer} from '../http/server.js';
import {AiGradingService} from '../ai/ai-grading-service.js';

const model=answerAreaModel(),code=fileURLToPath(new URL('../../../',import.meta.url)),product=path.dirname(code);
function ink(id='answer',height=480){return {...model.create({id,width:760,height}),strokes:[{id:'stroke-one',color:'#000000',width:5,points:[{x:20,y:20,pressure:1},{x:100,y:Math.min(height-10,1400),pressure:.6}]}]};}
function decode(bytes){let offset=8,width,height;const parts=[];while(offset<bytes.length){const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+size);if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);}if(type==='IDAT')parts.push(data);offset+=size+12;}return {width,height,rows:inflateSync(Buffer.concat(parts))};}
async function fixture(t,{memory=false}={}){
  const parent=path.join(product,'.temp','answer-area-tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'case-'));
  const directory=path.join(root,'extensions/手写答题示例/手写简答题');copyFixture(path.join(code,'examples/handwritten-short-answer'),directory,{recursive:true});
  const raw=JSON.parse(fs.readFileSync(path.join(directory,'examples/bank.json')));raw.id='handwriting-bank';writeFixture(path.join(root,'question-banks/手写答题示例/示例/bank.json'),JSON.stringify(raw));
  const engine=await RuleEngine.create(code);engine.validationEnvironment=async()=>'fixture';const library=new Library(root,code,engine),resources=new ResourceStore(root,{memory}),store=new StateStore(root,engine,{memoryOnly:memory,resources}),collection=await library.collection('bank','handwriting-bank');
  t.after(()=>{library.close();engine.close();assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});});return {root,directory,engine,library,resources,store,collection,question:collection.questions[0]};
}
const action=(revision,name,answer)=>({requestId:randomUUID(),revision,action:name,data:{answer}});

test('full-area PNG includes offscreen ink, has correct dimensions, and excludes all unrelated material',()=>{
  const doc=ink('long',1800),png=renderAnswerArea(doc),image=decode(png);assert.equal(image.width,760);assert.equal(image.height,1800);
  const pixel=(x,y)=>[...image.rows.subarray(y*(760*3+1)+1+x*3,y*(760*3+1)+4+x*3)];assert.ok(pixel(99,1399).some(value=>value<240));assert.deepEqual(pixel(700,1700),[255,255,255]);assert.deepEqual(renderAnswerArea(doc),png);
});

test('shared draft ink uses the smooth brush at double resolution and clips crossing strokes to the answer range',async()=>{
  const doc={...ink(),inkSource:'draft',text:'文字答案',strokes:[{id:'crossing',width:5,color:'#000000',points:[{x:-200,y:200,pressure:1},{x:300,y:200,pressure:1},{x:1000,y:200,pressure:1}]}]};
  const png=renderAnswerArea(doc),image=await loadImage(png);assert.equal(image.width,1520);assert.equal(image.height,960);
  const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data];assert.ok(pixel(2,400)[0]<100);assert.ok(pixel(1518,400)[0]<100);assert.deepEqual(pixel(1400,900),[255,255,255,255]);
  assert.ok(ctx.getImageData(30,30,400,60).data.some((value,index)=>index%4!==3&&value<100),'typed text is included in the same crop');
  const resources=new ResourceStore('.',{memory:true}),blank={...doc,text:'',strokes:[]};assert.equal(prepareAnswerAreas({areas:[blank]},resources,{submit:true}).areas[0].snapshot,undefined);assert.equal(resources.memoryBytes(),0);
});

test('retry removes the shared answer source ink while retaining ordinary draft notes',async t=>{
  const f=await fixture(t),doc={...ink(),inkSource:'draft',anchor:{x:100,y:200,width:760,height:480}};
  const draft={schemaVersion:1,viewport:{x:0,y:0,zoom:1},paper:{color:'#ffffff',pattern:'plain'},strokes:[{...doc.strokes[0],points:doc.strokes[0].points.map(point=>({...point,x:point.x+100,y:point.y+200}))},{...doc.strokes[0],id:'outside-note',points:[{x:1,y:1,pressure:1}]}]};
  await f.store.act(f.collection,f.question,{requestId:randomUUID(),revision:0,action:'whiteboard',data:{draft}});
  await f.store.act(f.collection,f.question,action(1,'submit',{areas:[doc]}));
  const retried=await f.store.act(f.collection,f.question,{requestId:randomUUID(),revision:2,action:'retry',data:{}});
  assert.equal(retried.state.answer,null);assert.equal(retried.state.status,'unanswered');assert.deepEqual(retried.draft.strokes,[draft.strokes[1]]);
});

test('incoming snapshot references are stripped on draft and regenerated from validated ink on submit',()=>{
  const resources=new ResourceStore('.', {memory:true}),doc={...ink(),snapshot:{type:'image',attrs:{assetId:'a'.repeat(64)}}};
  const draft=prepareAnswerAreas({areas:[doc]},resources);assert.equal(draft.areas[0].snapshot,undefined);assert.equal(resources.memoryBytes(),0);
  const submitted=prepareAnswerAreas(draft,resources,{submit:true}),id=submitted.areas[0].snapshot.attrs.assetId;assert.notEqual(id,'a'.repeat(64));assert.equal(resources.read(id).mime,'image/png');assert.deepEqual([...imageReferences(submitted)],[id]);
  assert.throws(()=>prepareAnswerAreas({areas:[ink(),ink()]},resources),{code:'ANSWER_AREA_LIMIT'});
  assert.throws(()=>prepareAnswerAreas({areas:[{...ink(),strokes:[{...ink().strokes[0],points:[{x:-1,y:0,pressure:1}]}]}]},resources),{code:'INVALID_ANSWER_AREA'});
  const targeted={...ink(),targetId:'q-46'};assert.equal(prepareAnswerAreas({areas:[targeted]},resources,{targetIds:['q-46']}).areas[0].targetId,'q-46');
  assert.throws(()=>prepareAnswerAreas({areas:[targeted]},resources,{targetIds:['q-47']}),{code:'ANSWER_AREA_TARGET_UNKNOWN'});
  assert.throws(()=>renderAnswerArea(ink(),{budget:{remaining:1}}),{code:'ANSWER_AREA_RENDER_LIMIT'});
});

test('saved vector answers survive restart; submission creates immutable images and rules prepare those images for AI',async t=>{
  const f=await fixture(t),answer={areas:[ink()]};assert.equal(f.collection.extensionFor(f.question).answerAreasDeclared,true);
  const saved=await f.store.act(f.collection,f.question,action(0,'draft',answer));assert.deepEqual(saved.state.answer,answer);assert.equal(saved.state.answer.areas[0].snapshot,undefined);assert.equal(f.resources.memoryBytes(),0);
  const restored=new StateStore(f.root,f.engine);assert.deepEqual((await restored.question(f.collection,f.question)).state.answer,answer);
  const submitted=await restored.act(f.collection,f.question,action(1,'submit',answer));assert.equal(submitted.state.result.gradingStatus,'pending');assert.equal(submitted.state.result.score,null);
  const image=submitted.state.answer.areas[0].snapshot.attrs.assetId,bytes=f.resources.read(image).bytes,input=await restored.prepareAiGrading(f.collection,f.question,null);assert.equal(input.gradingInput.answer.length,1);assert.equal(input.gradingInput.answer[0].assetId,image);
  await restored.act(f.collection,f.question,{requestId:randomUUID(),revision:2,action:'retry',data:{}});await restored.act(f.collection,f.question,action(3,'draft',{areas:[{...ink(),strokes:[]}]}));
  assert.deepEqual(f.resources.read(image).bytes,bytes);const stale={...input};await assert.rejects(restored.bindAiTask(f.collection,f.question,stale,'old-task'),{code:'AI_RESULT_STALE'});
});

test('completion submits unsubmitted handwriting through the same renderer and keeps snapshot resources',async t=>{
  const f=await fixture(t),answer={areas:[ink()]};await f.store.act(f.collection,f.question,action(0,'draft',answer));const summary=await f.store.summary(f.collection);
  await f.store.submitSaved(f.collection,{requestId:randomUUID(),roundId:summary.roundId,summaryVersion:summary.summaryVersion});const current=await f.store.question(f.collection,f.question);
  assert.equal(current.state.status,'submitted');assert.equal(current.state.result.score,null);assert.ok(f.resources.read(current.state.answer.areas[0].snapshot.attrs.assetId));
});

test('typed answers save, submit and freeze without needing an image, and remain available for manual or text AI grading',async t=>{
  const f=await fixture(t),answer={areas:[{...ink(),strokes:[],text:'输入采集信息，处理转换信息，输出呈现结果。'}]};
  await f.store.act(f.collection,f.question,action(0,'draft',answer));
  const reopened=new StateStore(f.root,f.engine);assert.deepEqual((await reopened.question(f.collection,f.question)).state.answer,answer);
  const submitted=await reopened.act(f.collection,f.question,action(1,'submit',answer));assert.equal(submitted.state.result.gradingStatus,'pending');assert.equal(submitted.state.answer.areas[0].snapshot,undefined);
  const prepared=await reopened.prepareAiGrading(f.collection,f.question,null);assert.deepEqual(prepared.gradingInput.answer,[{type:'text',text:'正式答案：'+answer.areas[0].text}]);
  await reopened.act(f.collection,f.question,{requestId:randomUUID(),revision:2,action:'review',data:{review:{score:4.5}}});
  const summary=await reopened.summary(f.collection),done=await reopened.finish(f.collection,{requestId:randomUUID(),roundId:summary.roundId,summaryVersion:summary.summaryVersion});
  const history=await reopened.history('bank',f.collection.id,done.historyId);assert.equal(history.questions[0].payload.state.answer.areas[0].text,answer.areas[0].text);assert.equal(history.questions[0].payload.state.result.score,4.5);
});

test('mixed text and ink produce one complete image for AI and invalid text cannot replace the saved answer',async t=>{
  const f=await fixture(t),answer={areas:[{...ink(),text:'同时保留文字与手写'}]};await f.store.act(f.collection,f.question,action(0,'draft',answer));
  await assert.rejects(f.store.act(f.collection,f.question,action(1,'draft',{areas:[{...ink(),text:'x'.repeat(20001)}]})),{code:'INVALID_ANSWER_AREA'});
  assert.deepEqual((await f.store.question(f.collection,f.question)).state.answer,answer);
  const submitted=await f.store.act(f.collection,f.question,action(1,'submit',answer)),input=await f.store.prepareAiGrading(f.collection,f.question,null);
  assert.deepEqual(input.gradingInput.answer.map(block=>block.type),['image']);assert.equal(input.gradingInput.answer[0].assetId,submitted.state.answer.areas[0].snapshot.attrs.assetId);
  const bytes=f.resources.read(input.gradingInput.answer[0].assetId).bytes,image=await loadImage(bytes),canvas=createCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
  const textPixels=context.getImageData(15,15,250,30).data;assert.ok(textPixels.some((channel,index)=>index%4!==3&&channel<100),'typed Chinese is present in the single submitted image');
  const blueOnly=renderAnswerArea({...ink(),strokes:[],text:answer.areas[0].text});assert.notDeepEqual(bytes,blueOnly,'ink is present as well as typed text');
});

test('editing answer-area height persists to the question and keeps completed history dimensions frozen',async t=>{
  const f=await fixture(t),answer={areas:[ink()]};await f.store.act(f.collection,f.question,action(0,'submit',answer));
  await f.store.act(f.collection,f.question,{requestId:randomUUID(),revision:1,action:'review',data:{review:{score:4.5}}});
  const summary=await f.store.summary(f.collection),done=await f.store.finish(f.collection,{requestId:randomUUID(),roundId:summary.roundId,summaryVersion:summary.summaryVersion}),before=await f.store.history('bank',f.collection.id,done.historyId);
  const editor=await f.store.editor(f.library,f.collection,f.question);assert.match(editor.editor.html,/答题区大小/);
  const data=structuredClone(f.question.data);data.areas[0].height=720;
  await f.store.edit(f.library,f.collection,f.question,{requestId:randomUUID(),revision:editor.revision,contentVersion:editor.contentVersion,title:f.question.title,data});
  const reopened=await f.library.collection('bank',f.collection.id),restored=new StateStore(f.root,f.engine);assert.equal(reopened.questions[0].data.areas[0].height,720);assert.equal(reopened.questions[0].data.areas[0].id,'answer');
  assert.deepEqual(await restored.history('bank',reopened.id,done.historyId),before);assert.equal(before.questions[0].payload.state.answer.areas[0].height,480);
  assert.equal((await restored.question(reopened,reopened.questions[0])).state.status,'unanswered','height changes use the existing question-edit reset policy');
});

test('snapshot failure preserves the already saved vector answer and permits a successful retry',async t=>{
  const f=await fixture(t),answer={areas:[ink()]};await f.store.act(f.collection,f.question,action(0,'draft',answer));const original=f.store.resources.store.bind(f.store.resources);f.store.resources.store=()=>{throw Error('disk full');};
  await assert.rejects(f.store.act(f.collection,f.question,action(1,'submit',answer)),/disk full/);const kept=await f.store.question(f.collection,f.question);assert.equal(kept.state.revision,1);assert.equal(kept.state.status,'draft');assert.deepEqual(kept.state.answer,answer);
  f.store.resources.store=original;assert.equal((await f.store.act(f.collection,f.question,action(1,'submit',answer))).state.status,'submitted');
});

test('temporary practice retains both vectors and snapshots only in its memory resource store',async t=>{
  const f=await fixture(t,{memory:true}),answer={areas:[ink()]};await f.store.act(f.collection,f.question,action(0,'draft',answer));const submitted=await f.store.act(f.collection,f.question,action(1,'submit',answer));assert.ok(f.resources.read(submitted.state.answer.areas[0].snapshot.attrs.assetId));assert.equal(fs.existsSync(path.join(f.root,'.state/resources')),false);
});

test('completed history freezes the component source and submitted image even after the installed extension changes',async t=>{
  const f=await fixture(t),submitted=await f.store.act(f.collection,f.question,action(0,'submit',{areas:[ink()]}));
  const assetId=submitted.state.answer.areas[0].snapshot.attrs.assetId,bytes=f.resources.read(assetId).bytes;
  await f.store.act(f.collection,f.question,{requestId:randomUUID(),revision:1,action:'review',data:{review:{score:4.5}}});
  const summary=await f.store.summary(f.collection),completed=await f.store.finish(f.collection,{requestId:randomUUID(),roundId:summary.roundId,summaryVersion:summary.summaryVersion}),record=await f.store.history('bank',f.collection.id,completed.historyId);
  const page=record.page??Object.values(record.pages)[0];assert.equal(page.answerAreaComponent.version,'1.4.2');assert.match(page.answerAreaComponent.script,/createAnswerAreaService/);assert.equal(record.questions[0].payload.state.answer.areas[0].snapshot.attrs.assetId,assetId);
  fs.appendFileSync(path.join(f.directory,'practice.css'),'\n/* later update */');await f.library.collection('bank',f.collection.id);
  assert.deepEqual(await f.store.history('bank',f.collection.id,completed.historyId),record);assert.deepEqual(f.resources.read(assetId).bytes,bytes);
});

test('failed AI grading keeps pending handwriting and permits a manual score without changing its image',async t=>{
  const f=await fixture(t);const submitted=await f.store.act(f.collection,f.question,action(0,'submit',{areas:[ink()]})),image=submitted.state.answer.areas[0].snapshot.attrs.assetId;
  let receivedImage=false;const gateway={freeze(){return this;},async generate({gradingInput}){receivedImage=gradingInput.answer.some(block=>block.type==='image'&&block.assetId===image);throw Error('isolated model failure');}};
  const ai=new AiGradingService(f.root,f.store,f.library,gateway);t.after(()=>ai.close());let task=await ai.start(f.collection,f.question,{requestId:randomUUID()});
  const deadline=Date.now()+10000;while(!['failed','confirmed','superseded'].includes(task.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));task=await ai.get(f.collection,f.question,task.taskId);}
  assert.equal(task.status,'failed');assert.equal(receivedImage,true);const pending=await f.store.question(f.collection,f.question);assert.equal(pending.state.result.gradingStatus,'pending');assert.equal(pending.state.result.score,null);assert.equal(pending.state.answer.areas[0].snapshot.attrs.assetId,image);
  const reviewed=await f.store.act(f.collection,f.question,{requestId:randomUUID(),revision:pending.state.revision,action:'review',data:{review:{score:3}}});assert.equal(reviewed.state.result.score,3);assert.equal(reviewed.state.answer.areas[0].snapshot.attrs.assetId,image);
});

test('AI receives the generated image and confirms a score through the existing review rules',async t=>{
  const f=await fixture(t),submitted=await f.store.act(f.collection,f.question,action(0,'submit',{areas:[ink()]}));
  const image=submitted.state.answer.areas[0].snapshot.attrs.assetId;let received=null;
  const gateway={freeze(){return this;},async generate({gradingInput}){received=gradingInput;return {output:'{"score":4.5,"feedback":"isolated image grading fixture"}',provider:'fixture',model:'fixture',usage:{}};}};
  const ai=new AiGradingService(f.root,f.store,f.library,gateway);t.after(()=>ai.close());let task=await ai.start(f.collection,f.question,{requestId:randomUUID()});
  const deadline=Date.now()+10000;while(['queued','running','succeeded'].includes(task.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));task=await ai.get(f.collection,f.question,task.taskId);}
  assert.equal(task.status,'confirmed');assert.equal(received.answer[0].assetId,image);assert.ok(f.resources.read(image).bytes.length);
  const graded=await f.store.question(f.collection,f.question);assert.equal(graded.state.result.score,4.5);assert.equal(graded.state.result.gradingStatus,'graded');assert.equal(graded.state.answer.areas[0].snapshot.attrs.assetId,image);
});

for(const history of [true,false])test(`real HTTP exam freezes handwriting capability and snapshots on hand-in (history=${history})`,async t=>{
  const f=await fixture(t),bank=path.join(f.root,'question-banks/手写答题示例/示例/bank.json'),raw=JSON.parse(fs.readFileSync(bank));raw.features={history};fs.writeFileSync(bank,JSON.stringify(raw));
  const server=await QuizForgeServer.create({root:f.root,codeRoot:code,port:0});await server.start();t.after(()=>server.close());
  const origin=`http://127.0.0.1:${server.port()}`,headers={'Content-Type':'application/json','X-QuizForge-Practice-Session':randomUUID()};
  const call=async(url,body)=>{const response=await fetch(origin+url,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json;};
  const exam=await call('/api/collections/bank/handwriting-bank/exams',{requestId:randomUUID(),durationMinutes:null}),base=`/api/collections/exam/${exam.id}`;
  assert.equal(server.exams.collection(exam.id).extensionFor(f.question).answerAreasDeclared,true);
  const page=await call(base+`/questions/${f.question.id}/page`);assert.equal(page.answerAreasDeclared,true);assert.equal(page.answerAreaComponent.version,'1.4.2');
  const saved=await call(base+`/questions/${f.question.id}/actions`,action(0,'draft',{areas:[ink()]}));assert.equal(saved.state.answer.areas[0].snapshot,undefined);
  const handedIn=await call(base+'/exam',{requestId:randomUUID()});assert.equal(handedIn.status,'grading');
  const current=await call(base+`/questions/${f.question.id}`);assert.equal(current.state.status,'submitted');assert.equal(current.state.result.score,null);
  const image=current.state.answer.areas[0].snapshot.attrs.assetId;assert.equal((await call(base+'/resources/'+image)).mime,'image/png');
  const blocked=await fetch(origin+base+`/questions/${f.question.id}/actions`,{method:'POST',headers,body:JSON.stringify(action(current.state.revision,'draft',{areas:[ink()]}))});assert.equal(blocked.status,403);
  if(!history){assert.equal(fs.existsSync(path.join(f.root,'.state/resources',image+'.png')),false);}
});


test('image-only and mixed answers freeze one full offscreen composite and keep image resources after restart',async t=>{
 const f=await fixture(t),photo=createCanvas(30,30),paint=photo.getContext('2d');paint.fillStyle='#ff0000';paint.fillRect(0,0,30,30);const resource=f.resources.store('image/png',photo.toBuffer('image/png'));
 const answer={areas:[{...ink('answer',1800),text:'Full answer',images:[{type:'image',id:'photo',attrs:{assetId:resource.id},x:20,y:1400,width:80,height:80}]}]};
 await f.store.act(f.collection,f.question,action(0,'draft',answer));const reopened=new StateStore(f.root,f.engine),restored=await reopened.question(f.collection,f.question);assert.deepEqual(restored.state.answer,answer);
 const submitted=await reopened.act(f.collection,f.question,action(1,'submit',answer)),doc=submitted.state.answer.areas[0],input=await reopened.prepareAiGrading(f.collection,f.question,null);assert.deepEqual(input.gradingInput.answer.map(block=>block.type),['image']);assert.equal(input.gradingInput.answer[0].assetId,doc.snapshot.attrs.assetId);
 const composite=await loadImage(f.resources.read(doc.snapshot.attrs.assetId).bytes);assert.equal(composite.width,1520);assert.equal(composite.height,3600);const canvas=createCanvas(composite.width,composite.height),context=canvas.getContext('2d');context.drawImage(composite,0,0);const pixel=context.getImageData(100,2850,1,1).data;assert.deepEqual([...pixel],[255,0,0,255]);
 assert.deepEqual([...imageReferences(submitted.state.answer)].sort(),[resource.id,doc.snapshot.attrs.assetId].sort());
 const only={areas:[{...answer.areas[0],strokes:[],text:''}]};await reopened.act(f.collection,f.question,{requestId:randomUUID(),revision:2,action:'retry',data:{}});const imageOnly=await reopened.act(f.collection,f.question,action(3,'submit',only));assert.equal(imageOnly.state.result.gradingStatus,'pending');assert.ok(imageOnly.state.answer.areas[0].snapshot);
});

test('a missing image or clipped long text cannot submit a partial answer or replace the saved draft',async t=>{
 const f=await fixture(t),answer={areas:[ink()]};await f.store.act(f.collection,f.question,action(0,'draft',answer));
 const missing={...ink(),images:[{type:'image',id:'photo',attrs:{assetId:'f'.repeat(64)},x:10,y:10,width:50,height:50}]};await assert.rejects(f.store.act(f.collection,f.question,action(1,'submit',{areas:[missing]})),{code:'RESOURCE_NOT_FOUND'});
 await assert.rejects(f.store.act(f.collection,f.question,action(1,'submit',{areas:[{...ink(),text:'long\n'.repeat(100)}]})),{code:'ANSWER_AREA_TEXT_OVERFLOW'});assert.deepEqual((await f.store.question(f.collection,f.question)).state.answer,answer);
});
