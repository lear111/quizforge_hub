import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authPage,profilePage,deviceCards} from '../java-hub/src/main/resources/static/account-ui.mjs';
test('account forms reflect actual verification requirements and unavailable registration',()=>{
  const login=authPage('login',{authPolicy:{loginCodeRequired:true,loginCaptchaRequired:true}});assert.match(login,/data-send-code/);assert.match(login,/data-captcha/);assert.match(login,/current-password/);
  const register=authPage('register',{registrationReady:false,authPolicy:{invitationRequired:true,registrationCodeRequired:true}});assert.match(register,/name="invitationCode"/);assert.match(register,/<button class="btn-filled" type="submit" disabled>/);
  const simple=authPage('login',{authPolicy:{}});assert.doesNotMatch(simple,/data-captcha|data-send-code/);
});
test('user-centre contact data is escaped and does not invent balances or contact replacement',()=>{
  const html=profilePage({name:'<script>example</script>',email:null,phone:'+8613800138000',unverifiedContacts:['phone']});assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>example'));assert.match(html,/data-account-bind/);assert.match(html,/name="email"/);assert.doesNotMatch(html,/name="phone"/);assert.match(html,/已连接设备/);assert.match(html,/暂未开放/);
  assert.match(html,/class="pf-layout"/);assert.match(html,/class="pf-main"/);assert.match(html,/class="pf-side"/);assert.match(html,/id="pfName"/);assert.match(html,/待验证/);assert.doesNotMatch(html,/<details[^>]*\bopen(?:\s|>)/);assert.match(html,/余额暂不可查询/);assert.doesNotMatch(html,/128\.5|100238|¥|wgs\*\*\*/);
  const complete=profilePage({name:'已绑定账号',email:'sample@example.test',phone:'+8613800138000'});assert.doesNotMatch(complete,/data-account-bind|data-open-bind/);
});
test('device cards preserve real device actions and escape stored names without mock device state',()=>{
  const html=deviceCards([{id:'device-1',name:'"><img src=x onerror=alert(1)>',client:'web',lastUsed:Date.parse('2026-10-25T00:00:00Z')}]);
  assert.ok(!html.includes('<img'));assert.match(html,/&quot;&gt;&lt;img/);assert.match(html,/data-device-save/);assert.match(html,/data-device-revoke/);assert.match(html,/电脑/);assert.match(html,/2026/);assert.doesNotMatch(html,/当前在线|当前设备|广东|Windows 11/);
});
