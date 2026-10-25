// Compatibility command spelling. All maintenance operations now run in Java.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jar=process.env.HUB_JAVA_JAR||path.join(root,'java-hub/target/quizforge-hub-0.1.0-java-preview.jar');
if(!existsSync(jar))throw new Error('Build Java Hub first: mvn -f java-hub/pom.xml package');
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
// An older JAR without HubAdminCli fails to load this class; it cannot accidentally start a web server.
const child=spawn(java,['-Dloader.main=cloud.treenewbee.quizforge.hub.maintenance.HubAdminCli','-cp',jar,'org.springframework.boot.loader.launch.PropertiesLauncher',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,shell:false});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>{console.error('Cannot start Java maintenance; check JDK 21+ and JAVA_HOME.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
