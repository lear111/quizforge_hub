import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInvitations } from '../invitations.mjs';

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
} else if (['invite-create', 'invite-list', 'invite-revoke'].includes(action) && email) {
  try {
    const actor = db.prepare('SELECT id FROM users WHERE email=?').get(email.trim().toLowerCase())?.id;
    const invitations = createInvitations(db);
    if (action === 'invite-create') console.log(JSON.stringify(invitations.create(actor, Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 30)), null, 2));
    if (action === 'invite-list') console.log(JSON.stringify(invitations.list(actor), null, 2));
    if (action === 'invite-revoke') { invitations.revoke(actor, process.argv[4] ?? ''); console.log('已停用邀请码。'); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else { console.log('用法：node scripts/admin.mjs promote 邮箱\n      node scripts/admin.mjs demote 邮箱\n      node scripts/admin.mjs invite-create 管理员邮箱 [数量=1] [有效天数=30]\n      node scripts/admin.mjs invite-list 管理员邮箱\n      node scripts/admin.mjs invite-revoke 管理员邮箱 邀请码ID'); process.exitCode = 1; }
db.close();
