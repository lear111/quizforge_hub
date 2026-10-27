// Anonymous protocol verification; does not log the audio body or send account credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export async function verifySharedMedia(url,expectedSha,expectedBytes){
  const address=new URL(url);assert.equal(address.origin,'https://quizforge-test.treenewbee.cloud');
  assert.match(address.pathname,/^\/shared-media\/audio\/[a-f0-9]{64}\.(mp3|wav|ogg|m4a)$/);assert.match(expectedSha,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(expectedBytes)&&expectedBytes>16&&expectedBytes<=64*1024*1024);
  const checks=[];
  const read=(target=url,options={})=>fetch(target,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(120000),...options});
  function common(response){assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('access-control-allow-credentials'),null);assert.equal(response.headers.get('set-cookie'),null);}
  const response=await read();assert.equal(response.status,200);common(response);assert.match(response.headers.get('content-type'),/^audio\//);assert.match(response.headers.get('cache-control'),/max-age=31536000.*immutable/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,expectedBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),expectedSha);checks.push('GET exact bytes/MIME/immutable-cache/anonymous CORS');
  const head=await read(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),expectedBytes);assert.equal((await head.arrayBuffer()).byteLength,0);common(head);checks.push('HEAD size without body');
  const partial=await read(url,{headers:{Range:'bytes=0-15'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 0-15/${expectedBytes}`);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),bytes.subarray(0,16));common(partial);checks.push('Range 206 exact prefix');
  const condition=await read(url,{headers:{'If-None-Match':response.headers.get('etag')}});assert.equal(condition.status,304);common(condition);assert.match(condition.headers.get('cache-control'),/immutable/);checks.push('ETag 304 revalidation');
  const preflight=await read(url,{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:8787','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'range'}});assert.equal(preflight.status,204);common(preflight);assert.match(preflight.headers.get('access-control-allow-headers'),/Range/i);checks.push('local Web CORS preflight');
  for(const method of ['POST','PUT','DELETE']){const denied=await read(url,{method});assert.equal(denied.status,405);common(denied);await denied.arrayBuffer();}checks.push('POST/PUT/DELETE denied');
  const invalidRange=await read(url,{headers:{Range:`bytes=${expectedBytes+1}-`}});assert.equal(invalidRange.status,416);assert.doesNotMatch(invalidRange.headers.get('cache-control')||'',/immutable/);await invalidRange.arrayBuffer();checks.push('416 not cached as immutable');
  for(const headers of [{'If-Match':'"different"'},{'If-Unmodified-Since':'Thu, 01 Jan 1970 00:00:00 GMT'}]){
    const failed=await read(url,{headers});assert.equal(failed.status,412);assert.doesNotMatch(failed.headers.get('cache-control')||'',/immutable/);await failed.arrayBuffer();
  }checks.push('412 not cached as immutable');
  const prefix=address.origin+'/shared-media/';
  const bare=await read(address.origin+'/shared-media');assert.equal(bare.status,404);await bare.arrayBuffer();
  for(const suffix of ['', 'audio/', '.incoming/', 'audio/private.json', `audio/${'0'.repeat(64)}.mp3`]){
    const denied=await read(prefix+suffix);assert.equal(denied.status,404);assert.doesNotMatch(denied.headers.get('cache-control')||'',/immutable/);await denied.arrayBuffer();
  }checks.push('no directory listing, arbitrary files or immutable negative cache');
  return {environment:'test',url,sha256:expectedSha,bytes:expectedBytes,checks,passed:checks.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [url,sha,size]=process.argv.slice(2);verifySharedMedia(url,sha,Number(size)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
