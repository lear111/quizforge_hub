import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,randomBytes,scryptSync,createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {legacyDatabase} from './helpers/legacy-data.mjs';
import {snapshot} from '../scripts/snapshot-hub-for-java.mjs';
const jar=process.env.HUB_JAVA_JAR;
const hash=value=>createHash('sha256').update(value).digest('hex');
const password='synthetic-node-java-互认-password';
test('Java preserves legacy password, cookie, OTP and device encodings',{skip:!jar,timeout:120000},async t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'qfh-java-auth-interop-')),source=path.join(work,'node'),target=path.join(work,'java');
  const pepper='synthetic-email-pepper-for-interop-'.repeat(2),proof='123456';
  const db=legacyDatabase(source);
  let java,exit;
  t.after(async()=>{if(java&&java.exitCode===null){java.kill();await exit;}fs.rmSync(work,{recursive:true,force:true});});
  db.exec('UPDATE authentication_policy SET registration_code=0,registration_captcha=0;UPDATE ai_signup_bonus SET amount=777;');
  const id=randomUUID(),raw=randomBytes(32).toString('hex'),salt=randomBytes(16).toString('hex'),encoded=salt+':'+scryptSync(password,salt,64).toString('hex');
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,'old@example.test','旧账号',encoded,0,new Date().toISOString());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw),id,Date.now()+3600000);
  db.prepare('INSERT INTO ai_points VALUES(?,?,?)').run(id,4321,Date.now());
  const deviceToken='qfd_'+randomBytes(32).toString('base64url'),deviceId=randomUUID();
  db.prepare('INSERT INTO connect_devices(id,user_id,token,name,client,created,last_used) VALUES(?,?,?,?,?,?,?)').run(deviceId,id,hash(deviceToken),'原设备','web',new Date().toISOString(),Date.now());
  const hmac=value=>createHmac('sha256',pepper).update(value).digest('hex'),nonce=randomUUID();
  db.prepare("INSERT INTO email_codes VALUES(?,?,?,?,0,'sent',1)").run(hmac('proof@example.test'),nonce,hmac(nonce+':proof@example.test:'+proof),Date.now()+600000);
  // Closed synthetic legacy data is copied; no old Hub server is started.
  await snapshot(source,target,{sourceStopped:true});
  db.close();
  java=spawn(process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java',['-jar',path.resolve(jar),'--server.port=0','--hub.data-dir='+target],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HUB_DEVICE_CONNECT_ENABLED:'true',TENCENT_SES_ENABLED:'1',TENCENT_SECRET_ID:'synthetic-id',TENCENT_SECRET_KEY:'synthetic-key',TENCENT_SES_FROM:'sender@example.test',TENCENT_SES_TEMPLATE_ID:'123',EMAIL_CODE_PEPPER:pepper,TURNSTILE_SITE_KEY:'',TURNSTILE_SECRET_KEY:'',PUBLIC_ORIGIN:''}});
  exit=once(java,'exit');let output='',origin;
  java.stdout.on('data',chunk=>{output+=chunk;const match=/Tomcat started on port (\d+)/.exec(output);if(match)origin='http://127.0.0.1:'+match[1];});java.stderr.on('data',chunk=>{output+=chunk;});
  const deadline=Date.now()+60000;while(!origin&&java.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));assert.ok(origin,'Java did not start: '+output.slice(-2500));
  const call=(base,route,body,cookie,extra={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
  await t.test('old cookie and Node scrypt credentials resolve to the same stable account',async()=>{
    const cookie='qfh_session='+raw;
    const expected={user:{id,name:'旧账号',email:'old@example.test',phone:null,admin:0}};assert.deepEqual(await(await call(origin,'/api/me',undefined,cookie)).json(),expected);
    const login=await call(origin,'/api/auth/login',{identifier:'OLD@example.test',password});assert.equal(login.status,200);assert.deepEqual(await login.json(),expected);assert.match(login.headers.get('set-cookie'),/^qfh_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax/);
    const check=new DatabaseSync(path.join(target,'hub.sqlite'),{readOnly:true});assert.equal(check.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(id).balance,4321);check.close();
  });
  let newUser;
  await t.test('a Java-generated password and signup bonus preserve the legacy encoding and units',async()=>{
    const registered=await call(origin,'/api/auth/register',{email:'new@example.test',name:'Java新账号',password});assert.equal(registered.status,201);newUser=(await registered.json()).user;
    const check=new DatabaseSync(path.join(target,'hub.sqlite'),{readOnly:true});const stored=check.prepare('SELECT * FROM users WHERE id=?').get(newUser.id),unverified=check.prepare('SELECT channel,contact FROM unverified_contacts WHERE user_id=?').all(newUser.id);assert.equal(check.prepare('SELECT balance FROM ai_points WHERE user_id=?').get(newUser.id).balance,777);check.close();
    assert.equal(stored.password.split(':')[1],scryptSync(password,stored.password.split(':')[0],64).toString('hex'));
    assert.deepEqual(unverified.map(row=>({...row})),[{channel:'email',contact:'new@example.test'}]);
    assert.equal(stored.id,newUser.id);
  });
  await t.test('a pre-migration Node email proof can be consumed once by Java',async()=>{
    const control=new DatabaseSync(path.join(target,'hub.sqlite'));control.exec('UPDATE authentication_policy SET registration_code=1');control.close();
    const input={email:'proof@example.test',name:'验证码迁移',password,code:proof};const registered=await call(origin,'/api/auth/register',input);assert.equal(registered.status,201,await registered.clone().text());assert.deepEqual((await registered.json()).user.unverifiedContacts||[],[]);
    assert.equal((await call(origin,'/api/auth/register',input)).status,400);
  });
  await t.test('an existing device token and balance are retained without leaking contacts',async()=>{
    const response=await call(origin,'/api/connect/me',undefined,null,{Authorization:'Bearer '+deviceToken});assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.user,{name:'旧账号'});assert.equal(result.device.id,deviceId);assert.equal(result.ai.balance,4321);assert.equal(result.ai.enabled,false);assert.ok(!JSON.stringify(result).includes('old@example.test'));
  });
  await t.test('new login and account resources are served as same-origin Java assets',async()=>{
    for(const route of ['/manage/','/account-ui.mjs','/account.css','/device-consent.js'])assert.equal((await call(origin,route)).status,200,route);
    const bad=await call(origin,'/api/auth/login',{email:'old@example.test',password},null,{Origin:'https://untrusted.example'});assert.equal(bad.status,403);assert.equal(bad.headers.get('set-cookie'),null);
    const config=await(await call(origin,'/api/config')).json();assert.equal(config.authPolicy.registrationCodeRequired,true);assert.equal(JSON.stringify(config).includes(pepper),false);assert.equal(JSON.stringify(config).includes('synthetic-key'),false);
  });
});
