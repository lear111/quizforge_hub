import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectAudio,uploadAudio,MAX_AUDIO_BYTES} from '../scripts/upload-shared-audio.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){const base=path.join(root,'.temp/shared-media-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'audio-'));t.after(()=>{assert.equal(path.dirname(dir),base);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('operator uploader creates deterministic content-addressed URLs without contacting the server in dry run',async t=>{
  const dir=fixture(t),file=path.join(dir,'听力.MP3'),bytes=Buffer.from('ID3synthetic-audio');fs.writeFileSync(file,bytes);
  const a=await uploadAudio(file,{dryRun:true,publish:()=>assert.fail('dry run contacted server')});
  assert.equal(a.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(a.bytes,bytes.length);assert.match(a.url,/^https:\/\/quizforge-test\.treenewbee\.cloud\/shared-media\/audio\/[a-f0-9]{64}\.mp3$/);
  const copy=path.join(dir,'copied.mp3');fs.copyFileSync(file,copy);assert.equal((await inspectAudio(copy)).url,a.url);
  fs.appendFileSync(copy,'updated');assert.notEqual((await inspectAudio(copy)).url,a.url);
});
test('operator uploader rejects invalid headers, missing, empty and oversized files before publishing',async t=>{
  const dir=fixture(t);let calls=0;const publish=()=>{calls++;};
  for(const [name,bytes] of [['fake.mp3','not audio'],['bad.html','ID3x'],['empty.mp3','']]){const file=path.join(dir,name);fs.writeFileSync(file,bytes);await assert.rejects(uploadAudio(file,{publish}));}
  const oversized=path.join(dir,'huge.mp3'),fd=fs.openSync(oversized,'w');fs.ftruncateSync(fd,MAX_AUDIO_BYTES+1);fs.closeSync(fd);await assert.rejects(uploadAudio(oversized,{publish}));
  await assert.rejects(uploadAudio(path.join(dir,'missing.mp3'),{publish}));assert.equal(calls,0);
});
test('operator uploader accepts only a matching publisher receipt',async t=>{
  const dir=fixture(t),file=path.join(dir,'a.ogg');fs.writeFileSync(file,'OggSdemo');
  const good=await uploadAudio(file,{publish:async item=>({...item,status:'uploaded'})});assert.equal(good.status,'uploaded');
  await assert.rejects(uploadAudio(file,{publish:async item=>({...item,status:'uploaded',url:'https://other.example/audio'})}),/does not match/);
});
