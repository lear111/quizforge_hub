import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('临时提示页提供网盘链接与提取码，保留管理入口和原有数据接口', async t => {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'quizforge-notice-'));
  let server;
  const start=async options=> {
    ({server}=await createApp({dataDir,mailProvider:{ready:false},...options}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close=()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  t.after(async()=>{await close();await rm(dataDir,{recursive:true,force:true});});
  let origin=await start({downloadNotice:true,downloadNoticeUrl:'https://pan.quark.cn/s/example123',downloadNoticeCode:'Me99'});
  const response=await fetch(origin+'/'); const html=await response.text();
  assert.equal(response.status,200); assert.match(html,/网站仍在完善中/); assert.match(html,/https:\/\/pan\.quark\.cn\/s\/example123/);
  assert.match(html,/>Me99<\/code>/); assert.match(html,/rel="noopener noreferrer"/); assert.match(html,/src="\/notice\.js"/); assert.equal(html.includes('src="/app.js"'),false);
  assert.equal((await fetch(origin+'/',{method:'HEAD'})).status,200);
  assert.equal((await fetch(origin+'/',{method:'HEAD'})).headers.get('cache-control'),'no-cache');
  for(const route of ['/notice.css','/notice.js','/quizforge-icon.png']) { const asset=await fetch(origin+route); assert.equal(asset.status,200); await asset.arrayBuffer(); }
  assert.match(await(await fetch(origin+'/manage/')).text(),/src="\/app\.js"/);
  assert.equal((await fetch(origin+'/api/reviews')).status,401);
  assert.equal((await(await fetch(origin+'/api/packs')).json()).count,0);
  assert.equal((await fetch(origin+'/public/notice.html')).status,404);
  await close(); origin=await start({downloadNotice:false});
  const original=await(await fetch(origin+'/')).text(); assert.match(original,/src="\/app\.js"/); assert.equal(original.includes('网站仍在完善中'),false);
});

test('提示页仅接受合法 HTTPS 网盘链接，提取码按文本展示', async t => {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'quizforge-notice-input-'));
  let server;
  t.after(async()=>{
    if (server) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await rm(dataDir,{recursive:true,force:true});
  });
  for(const url of ['javascript:alert(1)','http://pan.quark.cn/s/test','https://pan.quark.cn.evil.example/s/test','https://user:pass@pan.quark.cn/s/test','https://pan.quark.cn:444/s/test','https://pan.quark.cn/not-a-share']) {
    await assert.rejects(createApp({dataDir,downloadNotice:true,downloadNoticeUrl:url}),/DownloadNoticeURLInvalid/);
  }
  ({server}=await createApp({dataDir,downloadNotice:true,downloadNoticeUrl:'https://pan.baidu.com/s/example',downloadNoticeCode:'<img src=x>'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const html=await(await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  assert.match(html,/前往百度网盘/); assert.match(html,/&lt;img src=x&gt;/); assert.equal(html.includes('<img src=x>'),false);
});
