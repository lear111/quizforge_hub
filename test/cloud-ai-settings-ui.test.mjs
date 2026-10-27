import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';
import {readCloudAiPrefs} from '../practice/public/cloud/ai-preferences.js';import {ordinaryPracticeAsset} from '../practice/server/cloud/practice-ui.mjs';
const runtime=process.env.QFH_TEST_RUNTIME,ui=process.env.QFH_TEST_UI_PACKAGE;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
for(const saved of [null,{enabled:false,autoGrade:false,useOfficial:false,useCustom:true}])test(saved?'saved cloud AI choices still win when opening settings during startup':'new cloud AI defaults are ready before the first settings visit and match all checkboxes',{skip:!runtime||!ui},async t=>{
 const {JSDOM}=createRequire(path.resolve(ui))('jsdom');const html=ordinaryPracticeAsset('index.html',fs.readFileSync(path.join(runtime,'core/web/index.html'),'utf8'),'/cloud/practice/workspace');const dom=new JSDOM(html,{url:'https://practice.example/'});t.after(()=>dom.window.close());
 const document=dom.window.document;dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 if(saved)dom.window.localStorage.setItem('qfh.ai.prefs.v1:user',JSON.stringify(saved));
 let release;const identity=new Promise(resolve=>{release=resolve;}),seen=[];
 const sandbox={document,location:dom.window.location,localStorage:dom.window.localStorage,AbortSignal,readCloudAiPrefs,bindAdminContact(){},bindActivity(){},bindCloudLibrary(){},bindCloudAi(){},setCloudAiPrefs(value){seen.push(value);},fetch:async route=>{
  if(route==='/api/me'){await identity;return Response.json({user:{id:'user',name:'synthetic'}});}
  if(route==='/api/cloud/me')return Response.json({usage:{storageBytes:0,dailyTrafficBytes:0},limits:{storageBytes:100,dailyTrafficBytes:100}});
  if(route==='/api/cloud/ai/hub')return Response.json({connected:true,ai:{enabled:true,balance:100}});
  throw Error('unexpected route '+route);
 }};
 const source=fs.readFileSync(new URL('../practice/public/cloud/experience.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');vm.runInNewContext(source+';globalThis.bind=bindCloudExperience;',sandbox);sandbox.bind({document,beforeLogout:async()=>{}});
 document.querySelector('#settings-ai-tab').click();assert.equal(document.querySelector('#ai-settings-enabled').disabled,true);
 release();for(let i=0;i<5;i++)await tick();
 const expected=saved||{enabled:true,autoGrade:true,useOfficial:true,useCustom:false};assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1))),expected);
 for(const [name,value] of Object.entries(expected)){assert.equal(document.querySelector('#ai-settings-'+name).checked,value);assert.equal(document.querySelector('#ai-settings-'+name).disabled,false);}
 assert.equal(dom.window.localStorage.getItem('qfh.ai.prefs.v1:user'),saved?JSON.stringify(saved):null);
});
