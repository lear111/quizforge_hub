import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginContact, accountByContact } from '../accounts.mjs';
import { createInvitations } from '../invitations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || path.join(root, 'data')), 'hub.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const [action, identifier] = process.argv.slice(2);
const contact = identifier && loginContact({ identifier });
const account = contact && accountByContact(db, contact);
if (action === 'promote' && identifier) {
  const result = db.prepare('UPDATE users SET admin=1 WHERE id=?').run(account?.id || '');
  if (!result.changes) { console.error('找不到该账号，请先在网站注册。'); process.exitCode = 1; }
  else console.log('已授予管理员权限，请刷新网站。');
} else if (action === 'demote' && identifier) {
  db.prepare('UPDATE users SET admin=0 WHERE id=?').run(account?.id || ''); console.log('已撤销管理员权限。');
} else if (['invite-create', 'invite-list', 'invite-revoke'].includes(action) && identifier) {
  try {
    const actor = account?.id;
    const invitations = createInvitations(db);
    if (action === 'invite-create') console.log(JSON.stringify(invitations.create(actor, Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 30)), null, 2));
    if (action === 'invite-list') console.log(JSON.stringify(invitations.list(actor), null, 2));
    if (action === 'invite-revoke') { invitations.revoke(actor, process.argv[4] ?? ''); console.log('已停用邀请码。'); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else { console.log('用法：node scripts/admin.mjs promote 邮箱或手机号\n      node scripts/admin.mjs demote 邮箱或手机号\n      node scripts/admin.mjs invite-create 管理员邮箱或手机号 [数量=1] [有效天数=30]\n      node scripts/admin.mjs invite-list 管理员邮箱或手机号\n      node scripts/admin.mjs invite-revoke 管理员邮箱或手机号 邀请码ID'); process.exitCode = 1; }
db.close();
