import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createPublicPreview, rewritePreview, bootstrap } from '../cloud/public-preview.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('public test gateway requires live production admin identity and isolates production cookies', async t => {
  let admin = 1, checks = 0, lastHeaders;
  const token = 'a'.repeat(64);
  const auth = http.createServer((req, res) => { checks++; assert.equal(req.url, '/api/me'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ user: req.headers.cookie === `qfh_session=${token}` ? { admin } : null })); });
  const upstream = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === '/__preview/identity') { res.setHeader('Set-Cookie', ['qfh_preview_role=reader; Path=/; HttpOnly; SameSite=Strict', 'qfh_session=never-forward']); res.end('ok'); return; }
    if (req.url === '/cloud/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><head></head><body><a href="/cloud/ai">AI</a></body></html>'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end('{"userText":"/api/cloud/keep","path":"/cloud/ai"}');
  });
  const authPort = await listen(auth), upstreamPort = await listen(upstream);
  const gateway = createPublicPreview({ authPort, upstreamPort }), port = await listen(gateway);
  t.after(() => Promise.all([gateway, upstream, auth].map(stop)));
  const request = (path = '/cloud-test/cloud/', extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: extra.method || 'GET', headers: { Host: 'quizforge.treenewbee.cloud', ...extra.headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', data => body += data); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end(extra.body);
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request(undefined, { headers: { 'X-User-Admin': '1' } })).status, 401);
  const headers = { Cookie: `qfh_session=${token}; unrelated=secret; qfh_preview_role=reader` };
  admin = 0; assert.equal((await request(undefined, { headers })).status, 403);
  admin = 1; const page = await request(undefined, { headers }); assert.equal(page.status, 200);
  assert.match(page.body, /src="\/cloud-test\/__gateway.js"/); assert.match(page.body, /href="\/cloud-test\/cloud\/ai"/);
  assert.equal(lastHeaders.cookie, 'qfh_preview_role=reader');
  const json = await request('/cloud-test/api/me', { headers }); assert.equal(json.body, '{"userText":"/api/cloud/keep","path":"/cloud/ai"}');
  assert.equal((await request('/cloud-test/__preview/identity', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const switched = await request('/cloud-test/__preview/identity', { method: 'POST', headers: { ...headers, Origin: 'https://quizforge.treenewbee.cloud' }, body: '{}' });
  assert.equal(switched.status, 200); assert.equal(lastHeaders.origin, 'http://localhost:4321');
  assert.deepEqual(switched.headers['set-cookie'], ['qfh_preview_role=reader; Path=/cloud-test/; HttpOnly; SameSite=Strict; Secure']);
  assert.equal((await request('/cloud-test', { headers })).headers.location, '/cloud-test/cloud/');
  assert.equal((await request('/cloud-test//api/me', { headers })).status, 400);
  assert.equal((await request('/cloud-test/../api/me', { headers })).status, 400);
  admin = 0; assert.equal((await request('/cloud-test/__gateway.js', { headers })).status, 403);
  assert.equal(checks, 6);
  await stop(auth); assert.equal((await request(undefined, { headers })).status, 502);
});

test('public mount preserves practice API composition, direct model URLs, JSON and separator literals', async () => {
  const source = `const a='/api/collections/'; const prefix="/api/cloud/practice/demo"; const sep='/'; const ui='/cloud/ai'; link.href='/api/packs/'; const html='<a href="/api/cloud/export">Export</a>';`;
  const rewritten = rewritePreview(source, 'text/javascript');
  assert.match(rewritten, /const a='\/api\/collections\//);
  assert.match(rewritten, /const prefix="\/api\/cloud\/practice\/demo"/);
  assert.match(rewritten, /const sep='\/'/);
  assert.match(rewritten, /const ui='\/cloud-test\/cloud\/ai'/);
  assert.match(rewritten, /link.href='\/cloud-test\/api\/packs\//);
  assert.match(rewritten, /href="\/cloud-test\/api\/cloud\/export"/);
  const calls = [];
  const window = { fetch: (...args) => { calls.push(args); return Promise.resolve(); } };
  vm.runInNewContext(bootstrap, { window, URL, Request, location: { href: 'https://quizforge.treenewbee.cloud/cloud-test/cloud/', origin: 'https://quizforge.treenewbee.cloud' } });
  await window.fetch('/api/cloud/practice/demo' + '/api/collections/bank/demo');
  await window.fetch('/cloud-test/api/me');
  await window.fetch('https://model.example/v1/chat/completions', { headers: { Authorization: 'Bearer synthetic' } });
  assert.equal(calls[0][0], 'https://quizforge.treenewbee.cloud/cloud-test/api/cloud/practice/demo/api/collections/bank/demo');
  assert.equal(calls[1][0], '/cloud-test/api/me');
  assert.equal(calls[2][0], 'https://model.example/v1/chat/completions');
});
