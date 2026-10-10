import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEmailCodes } from '../email-codes.mjs';
import { createApp } from '../server.mjs';
import { createMailProvider, mailSettings, signedEmailRequest } from '../mail.mjs';

function fixture(db = new DatabaseSync(':memory:'), settings = {}) {
  let time = Date.now(); const sent = [];
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE)');
  const provider = { ready: true, pepper: 'private-test-pepper'.repeat(3), verify: async token => token === 'valid',
    send: async (email, code) => { sent.push({ email, code }); }, ...settings };
  return { db, sent, codes: createEmailCodes(db, provider, () => time), advance: ms => time += ms };
}
const isStatus = status => error => error.status === status;
test('验证码绑定邮箱，错误次数不能重启清零，验证和创建账号原子完成', async () => {
  const f = fixture();
  await f.codes.send('a@example.test', 'ip', 'valid', 'localhost');
  const code = f.sent[0].code; assert.match(code, /^\d{6}$/);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM email_codes').get()).includes(code), false);
  assert.throws(() => f.codes.consume('other@example.test', code, () => {}), isStatus(400));
  for (let i = 0; i < 5; i++) assert.throws(() => f.codes.consume('a@example.test', 'abcdef', () => {}), isStatus(400));
  const restarted = fixture(f.db);
  assert.throws(() => restarted.codes.consume('a@example.test', code, () => {}), isStatus(400));
  f.advance(60001); await f.codes.send('a@example.test', 'ip', 'valid', 'localhost');
  const current = f.sent[1].code;
  assert.throws(() => f.codes.consume('a@example.test', current, () => { throw new Error('InsertFailed'); }), /InsertFailed/);
  f.codes.consume('a@example.test', current, () => f.db.prepare('INSERT INTO users VALUES (?,?)').run('a','a@example.test'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.throws(() => f.codes.consume('a@example.test', current, () => {}), isStatus(400));
  f.db.close();
});
test('无配置、人机验证失败及异常都不发信，验证码十分钟过期', async () => {
  for (const settings of [{ ready: false }, { verify: async () => false }, { verify: async () => { throw new Error('Timeout'); } }]) {
    const f = fixture(undefined, settings);
    await assert.rejects(f.codes.send('a@example.test', 'ip', 'valid', 'localhost'), isStatus(settings.ready === false ? 503 : 400));
    assert.equal(f.sent.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM email_sends').get().n, 0); f.db.close();
  }
  const f = fixture(); await f.codes.send('a@example.test', 'ip', 'valid', 'localhost');
  f.advance(600000); assert.throws(() => f.codes.consume('a@example.test', f.sent[0].code, () => {}), isStatus(400)); f.db.close();
});
test('并发发信只预留一次；失败仍扣额度且不能注册', async () => {
  const f = fixture(undefined, { send: async () => { throw new Error('UnknownDelivery'); } });
  const results = await Promise.allSettled([f.codes.send('a@example.test','ip','valid','localhost'), f.codes.send('a@example.test','ip','valid','localhost')]);
  assert.deepEqual(results.map(r=>r.reason.status).sort(), [429,503]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM email_sends').get().n, 1);
  assert.throws(() => f.codes.consume('a@example.test','123456',()=>{}), isStatus(400)); f.db.close();
});
test('邮箱每日5次、IP十分钟5次/每日20次、全站24小时100次，跨重启保留', async () => {
  let f = fixture();
  for (let i=0;i<5;i++) { await f.codes.send('a@example.test',`ip${i}`,'valid','localhost'); f.advance(60001); }
  await assert.rejects(f.codes.send('a@example.test','new','valid','localhost'),isStatus(429));
  const restarted = fixture(f.db); await assert.rejects(restarted.codes.send('a@example.test','new','valid','localhost'),isStatus(429)); f.db.close();
  f=fixture(); for(let i=0;i<5;i++) await f.codes.send(`${i}@example.test`,'ip','valid','localhost');
  await assert.rejects(f.codes.send('six@example.test','ip','valid','localhost'),isStatus(429));
  for(let batch=1;batch<4;batch++) { f.advance(600001); for(let i=0;i<5;i++) await f.codes.send(`${batch}-${i}@example.test`,'ip','valid','localhost'); }
  f.advance(600001); await assert.rejects(f.codes.send('daily@example.test','ip','valid','localhost'),isStatus(429)); f.db.close();
  f=fixture(); for(let i=0;i<100;i++) await f.codes.send(`${i}@example.test`,`ip${i}`,'valid','localhost');
  await assert.rejects(f.codes.send('extra@example.test','new','valid','localhost'),isStatus(429));
  f.advance(86400001); await f.codes.send('extra@example.test','new','valid','localhost'); f.db.close();
});
test('腾讯发信参数、签名与服务端人机验证，密钥不进入公开配置', async () => {
  const settings = mailSettings({ TENCENT_SES_ENABLED:'1',TENCENT_SECRET_ID:'test-id',TENCENT_SECRET_KEY:'test-secret',TENCENT_SES_FROM:'noreply@example.test',TENCENT_SES_TEMPLATE_ID:'224355',EMAIL_CODE_PEPPER:'p'.repeat(64),TURNSTILE_SITE_KEY:'site-key',TURNSTILE_SECRET_KEY:'captcha-secret' });
  assert.equal(settings.ready,true);
  const request=signedEmailRequest(settings,'a@example.test','123456',0);
  assert.equal(request.headers['X-TC-Region'],'ap-hongkong');
  assert.match(request.headers.Authorization,/Credential=test-id\/1970-01-01\/ses\/tc3_request/);
  assert.equal(JSON.parse(request.body).Template.TemplateData,'{"code":"123456"}');
  assert.equal(request.body.includes('test-secret'),false);
  let called = [];
  const provider=createMailProvider(settings,async (url,options)=>{ called.push({url,options}); return {ok:true,json:async()=>url.includes('siteverify')?{success:true,action:'register_email',hostname:'hub.example.test'}:{Response:{MessageId:'id'}}}; });
  assert.equal(await provider.verify('token','ip','hub.example.test'),true);
  assert.equal(await provider.verify('token','ip','wrong.example.test'),false);
  await provider.send('a@example.test','123456'); assert.equal(called.at(-1).url,'https://ses.tencentcloudapi.com/');
  assert.equal(mailSettings({...Object.fromEntries([]),TENCENT_SES_ENABLED:'1'}).ready,false);
  assert.equal(mailSettings({...{TENCENT_SES_ENABLED:'1',TENCENT_SECRET_ID:'id',TENCENT_SECRET_KEY:'key',TENCENT_SES_FROM:'a@b.test',TENCENT_SES_TEMPLATE_ID:'1',EMAIL_CODE_PEPPER:'p'.repeat(64),TURNSTILE_SITE_KEY:'1x00000000000000000000AA',TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA'}}).ready,false);
});
test('HTTP关闭发信时拒绝新注册，不泄露私有配置', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hub-email-test-')); const {server}=await createApp({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await rm(dir,{recursive:true,force:true});});
  const config=await (await fetch(origin+'/api/config')).json(); assert.equal(config.registrationReady,false); assert.equal(config.turnstileSiteKey,'');
  assert.equal(JSON.stringify(config).includes('SECRET'),false);
  for(const route of ['register','email-code']) {
    const response=await fetch(origin+'/api/auth/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:'用户',email:'a@example.test',password:'password-123'})});
    assert.equal(response.status,503); assert.equal(response.headers.get('set-cookie'),null);
  }
});
test('HTTP新账号必须正确验证；切换为关闭发信后已有账号仍可登录', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hub-email-flow-')); let app;
  const deliveries=new Map();
  const provider={ready:true,pepper:'stable-test-pepper'.repeat(3),verify:async token=>token==='valid',send:async(email,code)=>deliveries.set(email,code)};
  const start=async mailProvider=>{
    app=await createApp({dataDir:dir,mailProvider}); await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${app.server.address().port}`;
    return (route,body)=>fetch(origin+'/api/auth/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  };
  const stop=()=>new Promise(resolve=>{app.server.close(resolve);app.server.closeIdleConnections();});
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  let request=await start(provider);
  const input={name:'验证账号',email:'verified@example.test',password:'password-123'};
  assert.equal((await request('register',input)).status,400);
  assert.equal((await request('email-code',{email:input.email,captchaToken:'bad'})).status,400);
  assert.equal(deliveries.size,0);
  assert.equal((await request('email-code',{email:input.email,captchaToken:'valid'})).status,200);
  assert.equal((await request('register',{...input,email:'other@example.test',code:deliveries.get(input.email)})).status,400);
  const registered=await request('register',{...input,code:deliveries.get(input.email)});
  assert.equal(registered.status,201); assert.match(registered.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await request('register',{...input,code:deliveries.get(input.email)})).status,400);
  await stop(); request=await start({...provider,ready:false});
  assert.equal((await request('login',input)).status,200);
  assert.equal((await request('register',{...input,email:'new@example.test'})).status,503);
});
