import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('通过发布软链接启动时仍监听 HTTP，数据写入指定目录', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quizforge-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'entry.mjs');
  try { await symlink(fileURLToPath(new URL('../server.mjs', import.meta.url)), entry); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows 当前用户不能创建软链接'); return; }
    throw error;
  }
  const child = spawn(process.execPath, [entry], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0',
    DATA_DIR: path.join(dir, 'data'), MAIL_ENV_FILE: path.join(dir, 'absent.env'), TENCENT_SES_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('StartupTimeout')), 10000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = /QuizForge Hub: (http:\/\/localhost:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('ExitedBeforeListening')); });
  });
  const config = await (await fetch(`${address}/api/config`)).json();
  assert.equal(config.registrationReady, false);
  const packs = await (await fetch(`${address}/api/packs`)).json();
  assert.equal(packs.count, 0);
});
