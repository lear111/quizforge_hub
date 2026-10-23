import { CloudError } from './accounts.mjs';
import { contactValue } from '../admin-contact.mjs';

// Practice reads the Hub's one authoritative setting; no browser cookies or arbitrary URLs.
export function createAdminContactSource({ port = 4318, fetcher = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Hub port');
  return async () => {
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/api/admin-contact`, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Hub unavailable'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 32768) throw new Error('Contact response too large');
        chunks.push(chunk);
      }
      return contactValue(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { throw new CloudError(503, '管理员联系方式暂时无法读取，请稍后重试'); }
  };
}
