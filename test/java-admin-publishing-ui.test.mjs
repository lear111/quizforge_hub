import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {uploadForm,uploadDone,createPublishingUI} from '../java-hub/src/main/resources/static/publishing-ui.mjs';
const packageFile=process.env.QFH_TEST_UI_PACKAGE;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('admin upload forms describe direct publication and confirmation only appears for administrators',()=>{
 assert.doesNotMatch(uploadForm(),/name="codeReviewed"/);
 const admin=uploadForm(null,{administrator:true});assert.match(admin,/上传并发布/);assert.match(admin,/name="codeReviewed"/);assert.doesNotMatch(admin,/checked/);
 assert.match(uploadForm({title:'t'},{administrator:true}),/保存并发布/);
 const published=uploadDone({id:'p',title:'<unsafe>',status:'approved'});assert.match(published,/已发布/);assert.doesNotMatch(published,/等待审核|<unsafe>/);
});
test('admin code confirmation and retry stay on the saved pack instead of claiming publication',()=>{
 const p={id:'p',revision:3,title:'t',status:'pending'};
 const review=uploadDone(p,{state:'code-review-required',item:{id:'i',extensions:[{name:'<b>',digest:'a'.repeat(64),files:[{path:'rules.js'}]}]}});
 assert.match(review,/已保存，尚未发布/);assert.match(review,/data-publish-complete/);assert.match(review,/data-revision="3"/);assert.ok(review.includes('&lt;b&gt;'));assert.match(review,/data-publish-review-file/);
 assert.match(uploadDone(p,{state:'not-published',message:'<network>'}),/重试发布/);assert.doesNotMatch(uploadDone(p,{state:'not-published',message:'<network>'}),/<network>/);
});
test('administrator checks code and publishes the saved revision once from the upload page', {skip:!packageFile},async t=>{
 const {JSDOM}=createRequire(path.resolve(packageFile))('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://hub.example/#upload'});const saved={};
 for(const name of ['window','document','location','XMLHttpRequest','FormData']){saved[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:dom.window[name]});}
 dom.window.scrollTo=()=>{};t.after(()=>{for(const [key,desc] of Object.entries(saved)){if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key];}dom.window.close();});
 const pack={id:'11111111-1111-4111-8111-111111111111',revision:4,title:'saved',status:'pending'},calls=[];let release;
 const response=new Promise(resolve=>{release=resolve;});t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return response;});
 const root=dom.window.document.querySelector('#root'),ui=createPublishingUI({container:root,getUser:()=>({id:'owner',admin:1}),notice(){}});await ui.render();
 root.innerHTML=uploadDone(pack,{state:'code-review-required',item:{id:'review',extensions:[{digest:'a'.repeat(64),files:[{path:'rules.js'}]}]}});root.querySelector('[data-publish-code-reviewed]').checked=true;
 const button=root.querySelector('[data-publish-complete]'),selector=root.querySelector('[data-publish-review-file]');button.click();button.click();assert.equal(calls.length,1);assert.equal(button.disabled,true);assert.equal(selector.disabled,true);
 selector.value=selector.options[1].value;selector.dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(calls.length,1);
 assert.equal(calls[0].url,'/api/packs/'+pack.id+'/publish');assert.deepEqual(JSON.parse(calls[0].options.body),{revision:4,codeReviewed:true});
 release(Response.json({pack:{...pack,status:'approved'},publication:{state:'published'}}));await tick();await tick();assert.match(root.textContent,/已发布/);assert.doesNotMatch(root.textContent,/等待审核/);assert.equal(ui.isBusy(),false);ui.clear();
});
