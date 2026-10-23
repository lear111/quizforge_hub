import path from 'node:path';
import { createApp } from '../server.mjs';
import { HubLogin } from '../cloud/hub-login.mjs';
import { CloudError } from '../cloud/accounts.mjs';
import { createHubSource, hubImportTarget } from '../cloud/hub-source.mjs';
import { createPracticeAdminBridge } from '../admin/bridge.mjs';

if (!process.env.DATA_DIR || path.basename(path.resolve(process.env.DATA_DIR)) !== 'quizforge-hub-practice') throw new Error('Dedicated practice data directory required');
const practiceOrigin = 'https://practice.treenewbee.cloud', hubOrigin = 'https://quizforge.treenewbee.cloud';
const login = new HubLogin({ practiceOrigin, hubOrigin });
const reportActivity = async (req, kind) => {
  const token = login.token(req); if (!token) return;
  const response = await fetch('http://127.0.0.1:4318/internal/activity', { method: 'POST', headers: { Cookie: 'qfh_session=' + token, Origin: hubOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
};
// Free AI for the signed-in account (docs/HUB_CONNECT_AI.md 7.3): the Hub charges the
// session user; network failures surface as status 0.
const hubAi = {
  manageUrl: hubOrigin + '/manage/',
  async call(req, name, body, timeoutMs = 10000) {
    const token = login.token(req);
    if (!token) return { status: 401, body: { error: { code: 'HUB_LOGIN_REQUIRED', message: '登录已失效，请重新登录 Hub' } } };
    try {
      const response = await fetch('http://127.0.0.1:4318/internal/ai/' + name, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: 'qfh_session=' + token, Origin: hubOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      let value = null; try { value = await response.json(); } catch { }
      return { status: response.status, body: value };
    } catch (error) { return { status: 0, timeout: error?.name === 'TimeoutError', body: null }; }
  },
};
const app = await createApp({
  hubAi,
  dataDir: process.env.DATA_DIR, cloudEnabled: true, cloudRuntimeDir: process.env.CLOUD_RUNTIME_DIR,
  resolveCloudPack: createHubSource({ origin: hubOrigin, dataDir: process.env.DATA_DIR }),
  reportActivity,
  secureCookies: true, publicOrigin: practiceOrigin, practiceHome: true,
  mailProvider: { ready: false }, beforeRequest: async (req, res, url) => {
    if (await login.handle(req, res, url)) return true;
    if (url.pathname === '/cloud/import' && req.method === 'GET') {
      hubImportTarget(url.search);
      if (!await login.resolve(req)) {
        res.writeHead(303, { Location: '/auth/hub?return=' + encodeURIComponent(url.pathname + url.search), 'Cache-Control': 'no-store' }).end(); return true;
      }
    }
    if (url.pathname === '/manage/') { res.writeHead(303, { Location: hubOrigin + '/manage/#library', 'Cache-Control': 'no-store' }).end(); return true; }
    if (url.pathname === '/cloud/admin' || url.pathname.startsWith('/api/cloud/admin/')) throw new CloudError(404, '页面不存在');
    // The ordinary-user instance exposes practice and personal library routes;
    // public sharing/moderation remains on the original Hub instance.
    if (!['/', '/api/me', '/api/config', '/styles.css', '/quizforge-icon.png', '/favicon.svg'].includes(url.pathname) && !url.pathname.startsWith('/cloud/') && !url.pathname.startsWith('/api/cloud/')) throw new CloudError(404, '页面不存在');
    return false;
  }, identityProvider: req => login.resolve(req),
});
const { server } = app;
const adminBridge = process.env.ADMIN_ENABLED === '1' ? createPracticeAdminBridge({ library: app.cloudLibrary, reviews: app.reviewPackages, authenticate: token => login.identity(token) }).server : null;
adminBridge?.listen(Number(process.env.PRACTICE_ADMIN_PORT || 4324), '127.0.0.1');
server.requestTimeout = 135000;
server.listen(4323, '127.0.0.1', () => console.log('QuizForge ordinary-user practice site ready on loopback port 4323'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  const stopPublic = () => server.close(() => process.exit(0));
  // Finish an in-flight private delivery before the public server closes its DB.
  if (adminBridge) adminBridge.close(stopPublic); else stopPublic();
});
