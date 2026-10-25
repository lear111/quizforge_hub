import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';

export async function javaHost({dataDir,localImport=false}){
  if(!process.env.HUB_JAVA_JAR)throw new Error('Set HUB_JAVA_JAR to a verified Java build.');
  const executable=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
  const child=spawn(executable,['-Xmx192m','-jar',path.resolve(process.env.HUB_JAVA_JAR),'--server.port=0','--hub.data-dir='+dataDir,'--hub.local-import-enabled='+localImport],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PUBLIC_ORIGIN:'',TENCENT_SES_ENABLED:'false',ALIYUN_SMS_ENABLED:'false',REVIEW_EMAIL:''}});
  const exited=once(child,'exit');let output='',origin;
  child.stdout.on('data',chunk=>{output+=chunk;const match=/Tomcat started on port (\d+)/.exec(output);if(match)origin='http://127.0.0.1:'+match[1];});
  child.stderr.on('data',chunk=>output+=chunk);
  const close=async()=>{if(child.exitCode===null){child.kill();await exited;}};
  const deadline=Date.now()+60000;
  while(!origin&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  if(!origin){await close();throw new Error('Synthetic Java host failed to start: '+output.slice(-1200));}
  return {origin,close};
}
