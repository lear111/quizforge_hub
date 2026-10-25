import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {card,detail,downloads,bankCatalogView,commentsView} from '../java-hub/src/main/resources/static/catalog-view.mjs';
const item={id:'00000000-0000-0000-0000-000000000001',title:'<img src=x onerror=alert(1)>',summary:'<script>bad()</script>',description:'<b>plain</b>',author:'<svg onload=bad()>',status:'approved',revision:1,version:'1.0',screenshots:[],downloads:0,commentCount:1,archive:{name:'例题.qbank',size:120,sha256:'0'.repeat(64)}};
test('real catalogue content is escaped and never reuses prototype mock identities or counts',()=>{
  const html=card(item);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>bad'));assert.ok(!html.includes('onerror="'));assert.ok(html.includes('#pack/'+item.id));
  const page=detail(item,[{author:'<b>user</b>',body:'<img src=x>',created:'2026-10-24'}],{},null);
  assert.ok(page.includes('&lt;b&gt;plain'));assert.ok(page.includes('&lt;img src=x&gt;'));assert.ok(!page.includes('已选'));assert.ok(!page.includes('2009 年'));
});
test('downloads come from the published manifest and missing platforms stay unavailable',()=>{
  const html=downloads([{platform:'windows',file:'QuizForge-test-windows.exe',version:'1.2',bytes:1000,label:'<b>test</b>',sha256:'a'.repeat(64)}]);
  assert.ok(html.includes('/download/files/QuizForge-test-windows.exe'));assert.ok(html.includes('安装包暂未上架'));assert.ok(html.includes('&lt;b&gt;test'));
});
test('approved styles and responsive rules are retained without runnable demo data or external fonts',()=>{
  const root=new URL('../java-hub/src/main/resources/static/',import.meta.url),html=fs.readFileSync(new URL('index.html',root),'utf8'),css=fs.readFileSync(new URL('hub.css',root),'utf8');
  assert.ok(!html.includes('fonts.googleapis'));assert.ok(!html.includes('demoRole'));assert.ok(!html.includes('>wgs<'));assert.ok(!html.includes('const DATA'));
  assert.ok(css.includes('grid-template-areas: "head" "side" "body"'));assert.ok(css.includes('@media (max-width: 640px)'));
  assert.ok(html.includes('data-admin-contact'));assert.ok(html.includes('src="/hub.js"'));assert.ok(!html.includes('<script>'));
});
test('detail retains the approved sections, actual download and explicit unavailable import entries',()=>{
  const html=detail({...item,user_id:'author',summary:'真实简介'},[],{native:['package-catalog','selected-bank-export','comments-write','reports-write']},{id:'reader',name:'合成用户',admin:0});
  assert.match(html,/data-bank-catalog/);assert.match(html,/data-detail-download/);assert.match(html,/data-detail-comment/);assert.match(html,/data-detail-report/);assert.match(html,/class="file-icon"/);assert.match(html,/class="a-icon"/);assert.match(html,/暂未开放/);assert.doesNotMatch(html,/quizforge:\/\/|\/cloud\/import\?/);
  const anonymous=detail(item,[],{native:['comments-write']},null);assert.doesNotMatch(anonymous,/<form[^>]*data-detail-comment(?:\s|>)/);assert.match(anonymous,/登录/);
});
test('catalogue selection renders only real entries and does not estimate package sizes or scores',()=>{
  const banks=[{id:'a'.repeat(64),title:'<img src=x>',questionCount:8},{id:'b'.repeat(64),title:'B',questionCount:2,version:'1.2'}];
  const html=bankCatalogView(banks,new Set([banks[0].id]));assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/已选 <b>1<\/b> \/ 2 本/);assert.match(html,/8 张题卡/);assert.match(html,/1\.2/);assert.doesNotMatch(html,/<img|满分|MB|2009 年/);
});
test('comment actions match ownership and stored text is escaped',()=>{
  const comments=[{id:'comment-1',user_id:'writer',author:'<b>name</b>',body:'<img src=x>',created:'2026-10-25'}];
  assert.match(commentsView(comments,{id:'writer'}),/data-comment-delete/);assert.match(commentsView(comments,{id:'admin',admin:1}),/data-comment-delete/);assert.doesNotMatch(commentsView(comments,{id:'reader'}),/data-comment-delete/);assert.match(commentsView(comments,null),/&lt;img src=x&gt;/);
});
