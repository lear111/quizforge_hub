import path from 'node:path';
import { createApp } from '../server.mjs';
import { HubLogin } from '../cloud/hub-login.mjs';
import { CloudError } from '../cloud/accounts.mjs';
import { createHubSource, hubImportTarget } from '../cloud/hub-source.mjs';

if (!process.env.DATA_DIR || path.basename(path.resolve(process.env.DATA_DIR)) !== 'quizforge-hub-practice') throw new Error('Dedicated practice data directory required');
const practiceOrigin = 'https://practice.treenewbee.cloud', hubOrigin = 'https://quizforge.treenewbee.cloud';
const login = new HubLogin({ practiceOrigin, hubOrigin });
const { server } = await createApp({
  dataDir: process.env.DATA_DIR, cloudEnabled: true, cloudRuntimeDir: process.env.CLOUD_RUNTIME_DIR,
  resolveCloudPack: createHubSource({ origin: hubOrigin, dataDir: process.env.DATA_DIR }),
  downloadNotice: false, secureCookies: true, publicOrigin: practiceOrigin, practiceHome: true,
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
server.requestTimeout = 135000;
server.listen(4323, '127.0.0.1', () => console.log('QuizForge ordinary-user practice site ready on loopback port 4323'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
