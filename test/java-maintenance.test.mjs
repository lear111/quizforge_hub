import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {legacyDatabase} from './helpers/legacy-data.mjs';
const run=promisify(execFile),jar=process.env.HUB_JAVA_JAR;

test('maintenance command uses Java without a web server and requires explicit marked data',{skip:!jar,timeout:120000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qfh-cli-')),data=path.join(root,'含 空格数据');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const db=legacyDatabase(data);db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('11111111-1111-4111-8111-111111111111','cli@example.test','Synthetic CLI','!disabled',0,'then');db.close();
  const entry=fileURLToPath(new URL('../scripts/admin.mjs',import.meta.url)),options={windowsHide:true,timeout:30000,env:{...process.env,HUB_JAVA_DATA_DIR:'',DATA_DIR:'',SPRING_MAIN_WEB_APPLICATION_TYPE:'servlet',REVIEW_EMAIL:'',TENCENT_SES_ENABLED:'false',ALIYUN_SMS_ENABLED:'false'}};
  await assert.rejects(run(process.execPath,[entry,'signup-bonus'],options),e=>e.code===1);
  await assert.rejects(run(process.execPath,[entry,'signup-bonus','--data-dir='+data],options),e=>e.code===1);
  assert.equal(fs.existsSync(path.join(data,'java-hub-local.json')),false);
  fs.writeFileSync(path.join(data,'java-migration-snapshot.json'),JSON.stringify({complete:true,sourceStopped:true}));
  const command=async(...args)=>{const result=await run(process.execPath,[entry,...args,'--data-dir='+data],options);assert.doesNotMatch(result.stdout,/Tomcat|Started Hub/);return JSON.parse(result.stdout);};
  assert.equal((await command('promote','cli@example.test')).admin,true);
  assert.equal((await command('invite-create','cli@example.test','1','7')).items.length,1);
  assert.equal((await command('signup-bonus','1.25')).amount,12500);
  assert.equal((await command('demote','cli@example.test')).admin,false);
});
