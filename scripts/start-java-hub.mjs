import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jar=path.join(root,'java-hub/target/quizforge-hub-0.1.0-java-preview.jar');
if(!existsSync(jar))throw new Error('Build first: mvn -f java-hub/pom.xml package (JDK 21+ and Maven required).');
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
const child=spawn(java,['-jar',jar,...(!process.env.HUB_JAVA_DATA_DIR?['--hub.data-dir='+path.join(root,'java-hub/data-java')]:[]),...(!process.env.HUB_COOKIE_NAME?['--hub.cookie-name=qfh_java_preview']:[]),...process.argv.slice(2)],{cwd:root,stdio:'inherit',shell:false});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>{console.error('Cannot start Java Hub. Install JDK 21+ and set JAVA_HOME.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
