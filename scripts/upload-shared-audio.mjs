// Operator-only SSH upload. No HTTP upload endpoint and no credentials in manifests.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';

export const MAX_AUDIO_BYTES=64*1024*1024;
export const MEDIA_ORIGIN='https://quizforge-test.treenewbee.cloud';
const publisher='/usr/local/lib/quizforge-shared-media-test/publish.py';
const types={mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4'};

export async function inspectAudio(file){
  file=path.resolve(file);const info=fs.lstatSync(file),extension=path.extname(file).slice(1).toLowerCase();
  if(!info.isFile()||info.isSymbolicLink()||!info.size||info.size>MAX_AUDIO_BYTES||!types[extension])throw new Error('Use a regular MP3/WAV/OGG/M4A file of at most 64 MiB.');
  const digest=createHash('sha256');let header=Buffer.alloc(0),bytes=0;
  for await(const chunk of fs.createReadStream(file)){
    bytes+=chunk.length;if(bytes>MAX_AUDIO_BYTES)throw new Error('Audio exceeds 64 MiB.');
    if(header.length<16)header=Buffer.concat([header,chunk.subarray(0,16-header.length)]);
    digest.update(chunk);
  }
  const valid={mp3:header.subarray(0,3).toString()==='ID3'||header.length>=3&&header[0]===255&&(header[1]&224)===224,
    wav:header.subarray(0,4).toString()==='RIFF'&&header.subarray(8,12).toString()==='WAVE',
    ogg:header.subarray(0,4).toString()==='OggS',m4a:header.subarray(4,8).toString()==='ftyp'};
  if(bytes!==info.size||!valid[extension])throw new Error('Audio changed during inspection or has an unsupported header.');
  const sha256=digest.digest('hex'),relative=`audio/${sha256}.${extension}`;
  return {file,bytes,sha256,extension,mime:types[extension],path:relative,url:`${MEDIA_ORIGIN}/shared-media/${relative}`};
}

export async function sshPublish(item,host){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(host))throw new Error('Use a configured SSH alias without shell metacharacters.');
  const args=['-o','BatchMode=yes','-o','ConnectTimeout=15',host,'sudo','-n','python3',publisher,'--sha256',item.sha256,'--extension',item.extension,'--size',String(item.bytes)];
  const child=spawn('ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill(),10*60*1000);
  for(const [stream,append] of [[child.stdout,text=>stdout+=text],[child.stderr,text=>stderr+=text]])stream.on('data',chunk=>{append(chunk.toString());if(stdout.length+stderr.length>32768)child.kill();});
  const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`SSH publication failed (${code}): ${stderr.trim().slice(0,1000)}`)));});
  // Attach both handlers before awaiting: neither an early SSH failure nor EPIPE is unhandled.
  const results=await Promise.allSettled([finished,pipeline(fs.createReadStream(item.file),child.stdin)]);
  clearTimeout(timer);for(const result of results)if(result.status==='rejected')throw result.reason;
  return JSON.parse(stdout);
}

export async function uploadAudio(file,{host='work-codex-seoul',dryRun=false,publish=sshPublish}={}){
  const item=await inspectAudio(file);
  const result=dryRun?{status:'dry-run',...item}:await publish(item,host);
  if(result.sha256!==item.sha256||result.bytes!==item.bytes||result.url!==item.url||result.path!==item.path||result.mime!==item.mime||!['dry-run','uploaded','reused'].includes(result.status))throw new Error('Publisher response does not match the inspected audio.');
  return {source:item.file,status:result.status,sha256:item.sha256,bytes:item.bytes,mime:item.mime,path:item.path,url:item.url};
}

async function main(args){
  const files=[];let host='work-codex-seoul',output=null,dryRun=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('node scripts/upload-shared-audio.mjs [--dry-run] [--output NEW.json] [--ssh-host ALIAS] AUDIO...\nUploads only to the TEST shared library; prints immutable URLs.');return;}
    if(args[i]==='--dry-run')dryRun=true;
    else if(['--output','--ssh-host'].includes(args[i])){const option=args[i],value=args[++i];if(!value||value.startsWith('--'))throw new Error('Missing option value');if(option==='--output')output=path.resolve(value);else host=value;}
    else if(args[i].startsWith('--'))throw new Error('Unknown option: '+args[i]);else files.push(args[i]);
  }
  if(!files.length)throw new Error('Provide at least one audio file; use --help for usage.');
  if(output&&fs.existsSync(output))throw new Error('Output manifest already exists; choose a new filename.');
  const records=[];
  // Each upload is atomic. A later failure retains successful files and their stdout receipts.
  for(const file of files){const result=await uploadAudio(file,{host,dryRun});records.push(result);console.log(JSON.stringify(result));}
  if(output)fs.writeFileSync(output,JSON.stringify({schemaVersion:1,environment:'test',origin:MEDIA_ORIGIN,resources:records},null,2)+'\n',{flag:'wx'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
