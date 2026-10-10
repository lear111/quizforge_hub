import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || path.join(root, 'data')), 'hub.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const [action, email] = process.argv.slice(2);
if (action === 'promote' && email) {
  const result = db.prepare('UPDATE users SET admin=1 WHERE email=?').run(email.trim().toLowerCase());
  if (!result.changes) { console.error('找不到该账号，请先在网站注册。'); process.exitCode = 1; }
  else console.log('已授予管理员权限，请刷新网站。');
} else if (action === 'demote' && email) {
  db.prepare('UPDATE users SET admin=0 WHERE email=?').run(email.trim().toLowerCase()); console.log('已撤销管理员权限。');
} else { console.log('用法：node scripts/admin.mjs promote 邮箱\n      node scripts/admin.mjs demote 邮箱'); process.exitCode = 1; }
db.close();
