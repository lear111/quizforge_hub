import fs from 'node:fs';
import path from 'node:path';
import { CloudError } from './accounts.mjs';

const prefix = '/cloud/pwa/';
export const practiceManifestUrl = prefix + 'manifest.webmanifest';
// Only application metadata and these reviewed runtime icons are public. Never
// resolve a caller-supplied filename against a user's workspace or runtime root.
const icons = new Map([
  ['quizforge-icon-192.png', 'image/png'],
  ['quizforge-icon.png', 'image/png'],
  ['quizforge-maskable-192.png', 'image/png'],
  ['quizforge-maskable-512.png', 'image/png'],
  ['quizforge-touch-icon.png', 'image/png'],
  ['quizforge-icon.svg', 'image/svg+xml'],
]);
const manifest = Buffer.from(JSON.stringify({
  id: '/', name: 'QuizForge Hub', short_name: 'QuizForge',
  description: '你的云端刷题空间，题库与作答保存在账户中。', lang: 'zh-CN',
  start_url: '/', scope: '/', display: 'standalone',
  theme_color: '#ffffff', background_color: '#f8f9fc',
  icons: [
    { src: prefix + 'icons/quizforge-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: prefix + 'icons/quizforge-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: prefix + 'icons/quizforge-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: prefix + 'icons/quizforge-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));

export function servePracticePwa(req, res, pathname, core) {
  if (!pathname.startsWith(prefix)) return false;
  const filename = pathname.startsWith(prefix + 'icons/') ? pathname.slice((prefix + 'icons/').length) : null;
  const image = icons.has(filename);
  if (pathname !== practiceManifestUrl && !image) throw new CloudError(404, '页面资源不存在');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD'); throw new CloudError(405, '安装资源仅支持 GET 或 HEAD');
  }
  const bytes = image ? fs.readFileSync(path.join(core, 'web/assets', filename)) : manifest;
  res.writeHead(200, {
    'Content-Type': image ? icons.get(filename) : 'application/manifest+json; charset=utf-8',
    'Content-Length': bytes.length, 'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : bytes); return true;
}

export function practiceInstallHead(source) {
  const old = '<link rel="manifest" href="/manifest.webmanifest">';
  if (!source.includes(old)) throw new Error('Pinned Web manifest link changed; update cloud install adapter');
  return source.replace(old, `<link rel="manifest" href="${practiceManifestUrl}">`)
    .replace('href="/favicon.ico" sizes="16x16 32x32 48x48"', `href="${prefix}icons/quizforge-icon-192.png" sizes="192x192" type="image/png"`)
    .replace('href="/assets/quizforge-icon.svg"', `href="${prefix}icons/quizforge-icon.svg"`)
    .replace('href="/assets/quizforge-touch-icon.png"', `href="${prefix}icons/quizforge-touch-icon.png"`);
}
