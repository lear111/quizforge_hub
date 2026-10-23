import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const runtime = process.env.QFH_TEST_RUNTIME || fileURLToPath(new URL('../.runtime/web-20261023-coast-verified', import.meta.url));
const enabled = fs.existsSync(path.join(runtime, 'snapshot.json'));
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const name of ['单选题', '多选题', '判断题', '简答题', '简答题（答题区）']) {
  test(name + ' waits for pending input before retry and can retry after a stale submitted save failure', { skip: !enabled }, async () => {
    const source = fs.readFileSync(path.join(runtime, 'basic-content/extensions/基础题型', name, 'practice.js'), 'utf8');
    const prefix = source.slice(0, source.indexOf('(function'));
    let reportDone, failSave = false, timer;
    const reported = new Promise(resolve => { reportDone = resolve; }), calls = [];
    const context = { status: 'draft', capabilities: { canSave: true } };
    const sandbox = { setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {}, QF: {
      page: { reportAnswerState: async () => { await reported; return { ok: true, data: { stateId: 'state' } }; } },
      save: async value => { calls.push(value.purpose); return failSave ? { ok: false, error: { message: 'stale save failure' } } : { ok: true }; },
      requestAction: async () => { calls.push('retry'); return { ok: true }; },
    } };
    vm.runInNewContext(prefix + '\nglobalThis.factory=createAnswerSaver;', sandbox);
    const saver = sandbox.factory({ context: () => context, answer: () => ({ value: 'latest' }), statuses: () => [{ status: 'draft' }], onError() {}, onBusy() {} });
    saver.changed(); const retry = saver.retry(); await tick();
    assert.deepEqual(calls, [], 'Retry cannot race the outstanding input report');
    reportDone(); await retry; assert.deepEqual(calls, ['draft', 'retry']);
    failSave = true; saver.changed(); timer(); await tick();
    context.status = 'submitted'; context.capabilities.canSave = false;
    await saver.retry(); assert.equal(calls.at(-1), 'retry'); saver.dispose();
  });
}
