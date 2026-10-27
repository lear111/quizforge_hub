import { CloudError } from '../cloud/accounts.mjs';
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const reason = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new CloudError(400, '请填写 1–1000 字的操作原因');
  return value.trim();
};
export async function bytes(req, limit = 64 * 1024 ** 2) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new CloudError(413, '文件超过大小限制'); }
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new CloudError(413, '上传内容超过大小限制'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function jsonBody(req) {
  try { const value = JSON.parse((await bytes(req, 32768)).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if (error instanceof CloudError) throw error; throw new CloudError(400, '请求内容不是有效 JSON 对象'); }
}
export function filename(req) {
  let value; try { value = decodeURIComponent(req.headers['x-quizforge-filename'] || ''); } catch {}
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\/\x00-\x1f]/.test(value)) throw new CloudError(400, '文件名无效');
  return value;
}
export function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
