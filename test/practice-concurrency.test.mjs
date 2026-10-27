import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CloudPractice} from '../practice/server/cloud/practice.mjs';
import {createPracticeApp} from '../practice/server/app.mjs';

const runtime=process.env.QFH_TEST_RUNTIME||fileURLToPath(new URL('../.runtime/web-sync-20261027-network',import.meta.url));
const parent=fileURLToPath(new URL('../.temp/practice-concurrency-tests/',import.meta.url));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function within(promise,ms=5000,label='another user'){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' was blocked by an unrelated request')),ms);})]);}finally{clearTimeout(timer);}}
function directory(){fs.mkdirSync(parent,{recursive:true});return fs.mkdtempSync(path.join(parent,'case-'));}
function cleanup(root){assert.equal(path.dirname(root),parent.slice(0,-1));fs.rmSync(root,{recursive:true,force:true});}
function scheduler(t){const root=directory(),db=new DatabaseSync(':memory:');const p=new CloudPractice({root,db,remove(){}});t.after(async()=>{await p.close();db.close();cleanup(root);});return p;}

test('30 user queues progress independently; a user retains FIFO, error recovery and shutdown draining',async t=>{
  const p=scheduler(t),gate=deferred(),entered=deferred();let second=false;
  const first=p.serial('alice',async()=>{entered.resolve();await gate.promise;throw Error('synthetic failure');});
  const failed=assert.rejects(first,/synthetic failure/);
  try{
    await within(entered.promise);
    const next=p.serial('alice',()=>{second=true;return 'next';});
    const others=Array.from({length:29},(_,i)=>p.serial('user-'+i,()=>i));
    assert.deepEqual(await within(Promise.all(others)),Array.from({length:29},(_,i)=>i));assert.equal(second,false);
    const closing=p.close();let closed=false;closing.then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
    await assert.rejects(p.serial('new',()=>{}),{status:503});
    gate.resolve();await failed;assert.equal(await next,'next');await closing;
    assert.equal(p.lanes.size,0);assert.equal(p.pending,0);
  }finally{gate.resolve();await failed;}
});

test('a saturated account cannot consume another account queue and capacity is released',async t=>{
  const p=scheduler(t),gate=deferred(),entered=deferred();
  const work=[p.serial('alice',async()=>{entered.resolve();await gate.promise;})];
  try{await within(entered.promise);for(let i=1;i<16;i++)work.push(p.serial('alice',()=>i));
    await assert.rejects(p.serial('alice',()=>{}),{status:503});assert.equal(await within(p.serial('bob',()=>42)),42);
  }finally{gate.resolve();await Promise.allSettled(work);}
  assert.equal(p.lanes.size,0);assert.equal(p.pending,0);assert.equal(await p.serial('alice',()=>7),7);
});

const users=Object.fromEntries(['alice','bob','carol'].map((name,i)=>[name,{id:`${i+1}`.repeat(8)+'-'+`${i+1}`.repeat(4)+'-4'+`${i+1}`.repeat(3)+'-8'+`${i+1}`.repeat(3)+'-'+`${i+1}`.repeat(12),name,email:name+'@example.test',admin:0}]));
async function fixture(t){
  const root=directory(),app=await createPracticeApp({dataDir:root,cloudRuntimeDir:runtime,practiceHome:true,identityProvider:async req=>users[req.headers.cookie?.slice(5)]||null,cloud:{defaults:{storageBytes:128*1024**2,dailyTrafficBytes:128*1024**2,monthlyTrafficBytes:128*1024**2}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.server.closeAllConnections();await app.close();cleanup(root);});
  const request=(name,route,body)=>fetch(origin+route,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{Cookie:'user='+name,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const items={};for(const name of Object.keys(users)){assert.equal((await request(name,'/')).status,303);items[name]=app.cloudLibrary.list(users[name].id)[0];}
  const route=name=>'/api/cloud/practice/'+items[name].id+'/api/catalog';
  return {app,items,request,route};
}

test('real HTTP: a held user API cannot block another user or evict its active session',{skip:!fs.existsSync(runtime)},async t=>{
  const f=await fixture(t),p=f.app.cloudLibrary.practice;
  p.sessionLimit=2; // Exercise eviction without creating 33 real workspaces.
  assert.equal((await f.request('alice',f.route('alice'))).status,200);
  assert.equal((await f.request('bob',f.route('bob'))).status,200);
  const service=p.sessions.get(f.items.alice.id),original=service.api.bind(service),gate=deferred(),entered=deferred();
  let calls=0;service.api=async(context,route)=>{if(route==='/api/catalog'&&++calls===1){entered.resolve();await gate.promise;}return original(context,route);};
  const first=f.request('alice',f.route('alice'));let same,other,third;
  try{
    await within(entered.promise,5000,'held Alice handler');same=f.request('alice',f.route('alice'));other=f.request('bob',f.route('bob'));
    assert.equal((await within(other,5000,'warm Bob API')).status,200);assert.equal(calls,1);
    third=f.request('carol',f.route('carol'));assert.equal((await within(third,20000,'cold Carol API')).status,200);
    assert.equal(p.sessions.get(f.items.alice.id),service);
    assert.equal((await f.request('bob',f.route('alice'))).status,404);
  }finally{gate.resolve();await Promise.allSettled([first,same,other,third].filter(Boolean));}
  assert.equal((await first).status,200);assert.equal((await same).status,200);assert.equal(calls,2);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM cloud_practice_writes').get().n,0);

  // Re-entry during asynchronous LRU close must wait for the file lock to be
  // released, rather than borrowing the retiring host.
  const entries=[...p.sessions];p.sessions.clear();p.sessions.set(f.items.alice.id,service);
  for(const [id,value] of entries)if(id!==f.items.alice.id)p.sessions.set(id,value);
  const retiring=deferred(),finishClose=deferred(),close=service.close.bind(service);
  service.close=async()=>{retiring.resolve();await finishClose.promise;return close();};
  const lookup=p.session.bind(p),reentered=deferred();
  p.session=async row=>{if(row.id===f.items.alice.id&&p.retiring.has(row.id))reentered.resolve();return lookup(row);};
  const coldBob=f.request('bob',f.route('bob'));let reentry;
  try{await within(retiring.promise,5000,'LRU close');reentry=f.request('alice',f.route('alice'));
    await within(reentered.promise,5000,'retiring session lookup');assert.equal(calls,2);
  }finally{finishClose.resolve();}
  assert.equal((await coldBob).status,200);assert.equal((await reentry).status,200);
  assert.notEqual(p.sessions.get(f.items.alice.id),service);
  p.session=lookup;

  // A failed checkpoint restores only its owner's tree, even if another user
  // saves an answer while that checkpoint is still open.
  const library=f.app.cloudLibrary,bob=f.items.bob,bank=bob.banks[0],bobRoot=library.location(users.bob.id,bob.id);
  const raw=JSON.parse(fs.readFileSync(path.join(bobRoot,'question-banks',bank.path,'bank.json'))),question=raw.questions[0];
  const q='/api/cloud/practice/'+bob.id+'/api/collections/bank/'+bank.id+'/questions/'+question.id;
  const state=await(await f.request('bob',q)).json(),rolling=deferred(),rollback=deferred();
  const aliceRow=library.owned(users.alice.id,f.items.alice.id),proof=path.join(library.location(users.alice.id,aliceRow.id),'rollback-proof.txt');
  const broken=p.serial(users.alice.id,()=>p.checkpoint(aliceRow,async()=>{fs.writeFileSync(proof,'uncommitted');rolling.resolve();await rollback.promise;throw Error('synthetic rollback');}));
  const rejected=assert.rejects(broken,/synthetic rollback/);
  let saved;
  try{await within(rolling.promise);
    saved=await within(f.request('bob',q+'/actions',{requestId:randomUUID(),revision:state.state.revision,contentVersion:state.stamp.contentVersion,action:'draft',data:{answer:{selectedOptionId:question.data.correctOptionId}}}),10000,'Bob answer save');
    assert.equal(saved.status,200);
  }finally{rollback.resolve();await rejected;}
  assert.equal(fs.existsSync(proof),false);
  assert.deepEqual((await(await f.request('bob',q)).json()).state.answer,(await saved.json()).state.answer);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM cloud_practice_writes').get().n,0);
});
