import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAdminContactSource} from '../cloud/admin-contact.mjs';

test('the internal contact reader uses a fixed anonymous endpoint and rejects redirects, oversize or malformed data', async () => {
  let seen;
  const read = createAdminContactSource({ fetcher: async (url, options) => { seen = { url, options }; return new Response(JSON.stringify({ content: 'ok', revision: 1, private: 'not returned' })); } });
  assert.deepEqual(await read(), { content: 'ok', revision: 1 });
  assert.equal(seen.url, 'http://127.0.0.1:4338/api/admin-contact'); assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.credentials, 'omit'); assert.equal(seen.options.headers, undefined);
  for (const result of [new Response('', { status: 302 }), new Response('x'.repeat(32769)), new Response('{broken'), new Response('{"content":1,"revision":0}')]) {
    await assert.rejects(createAdminContactSource({ fetcher: async () => result })(), { status: 503 });
  }
});
