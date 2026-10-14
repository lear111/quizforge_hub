import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createReviewNotifications } from '../review-notifications.mjs';
import { createMailProvider, mailSettings, signedTemplateRequest } from '../mail.mjs';

test('审核邮件合并、失败重试、重启保留限额，不包含用户提交的内容', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE packs (status TEXT); INSERT INTO packs VALUES ('pending')");
  let time = Date.now(), sends = 0, shouldFail = false, recipients = [];
  const provider = { reviewReady: true, async sendReviewAlert(email) { sends++; recipients.push(email); if (shouldFail) throw new Error('private provider detail'); } };
  let worker = createReviewNotifications(db, provider, 'admin@example.test', () => time);
  await Promise.all([worker.wake(),worker.wake()]); assert.equal(sends,1);
  assert.equal(worker.state().queued,false);
  worker.enqueue(); worker.enqueue(); await worker.wake(); assert.equal(sends,1);
  worker.stop(); worker = createReviewNotifications(db,provider,'admin@example.test',()=>time);
  await worker.wake(); assert.equal(sends,1);
  time += 900000; shouldFail = true; await worker.wake(); assert.equal(sends,2);
  assert.equal(worker.state().queued,true); assert.equal(worker.state().error,'发送失败，将自动重试');
  time += 900000; await worker.wake(); assert.equal(sends,2);
  time += 900000; shouldFail = false; await worker.wake(); assert.equal(sends,3);
  for(let i=0;i<30;i++) { time += 900000; worker.enqueue(); await worker.wake(); }
  assert.equal(sends,24); assert.ok(recipients.every(e=>e==='admin@example.test'));
  worker.stop(); worker=createReviewNotifications(db,provider,'admin@example.test',()=>time); await worker.wake(); assert.equal(sends,24);
  time += 86400000; await worker.wake(); assert.equal(sends,25);
  worker.enqueue(); db.exec("UPDATE packs SET status='approved'"); time+=900000; await worker.wake(); assert.equal(sends,25); assert.equal(worker.state().queued,false);
  worker.stop(); db.close();
});

test('未配置提醒模板时队列保留且不发邮件；注册模板不会被复用', async () => {
  const db=new DatabaseSync(':memory:'); db.exec("CREATE TABLE packs(status TEXT); INSERT INTO packs VALUES('pending')");
  let sends=0;
  const worker=createReviewNotifications(db,{reviewReady:false,sendReviewAlert:async()=>sends++},'admin@example.test');
  await worker.wake(); assert.equal(sends,0); assert.equal(worker.state().ready,false); assert.equal(worker.state().queued,true); worker.stop(); db.close();
  const settings=mailSettings({TENCENT_SES_ENABLED:'1',TENCENT_SECRET_ID:'test-id',TENCENT_SECRET_KEY:'test-key',TENCENT_SES_FROM:'noreply@example.test',TENCENT_SES_TEMPLATE_ID:'123',TENCENT_SES_REVIEW_TEMPLATE_ID:'456'});
  assert.equal(settings.ready,false); assert.equal(settings.reviewReady,true);
  const request=signedTemplateRequest(settings,'admin@example.test','QuizForge 有题库等待审核',settings.reviewTemplateId);
  const payload=JSON.parse(request.body); assert.equal(payload.Template.TemplateID,456); assert.equal(payload.Template.TemplateData,'{}');
  assert.deepEqual(payload.Destination,['admin@example.test']); assert.equal(request.body.includes('test-key'),false);
  const sent=[];
  const provider=createMailProvider(settings,async(url,options)=> {sent.push(JSON.parse(options.body)); return {ok:true,json:async()=>({Response:{MessageId:'test-message'}})};});
  await provider.sendReviewAlert('admin@example.test'); assert.equal(sent.length,1); assert.equal(sent[0].Template.TemplateID,456);
});
