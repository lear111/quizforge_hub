import { CloudError } from './cloud/accounts.mjs';

export function contactValue(value) {
  if (!value || typeof value.content !== 'string' || value.content.length > 4000 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new CloudError(503, '管理员联系方式暂时不可用，请稍后重试');
  return { content: value.content, revision: value.revision };
}

export function createAdminContact(db) {
  db.exec("CREATE TABLE IF NOT EXISTS admin_contact(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL,revision INTEGER NOT NULL); INSERT OR IGNORE INTO admin_contact VALUES(1,'',0)");
  const get = () => contactValue(db.prepare('SELECT content,revision FROM admin_contact WHERE id=1').get());
  return {
    get,
    set(input) {
      if (!db.isTransaction) throw new Error('Contact updates must share the audit transaction');
      if (!input || Object.keys(input).some(key => !['content', 'revision'].includes(key)) || typeof input.content !== 'string' || input.content.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.content)) throw new CloudError(400, '联系方式请填写不超过 4000 字的纯文本');
      const previous = get();
      if (!Number.isSafeInteger(input.revision) || input.revision !== previous.revision) throw new CloudError(409, '联系方式已被更新，请重新读取后再保存');
      const content = input.content.replace(/\r\n?/g, '\n').trim();
      if (content !== previous.content) db.prepare('UPDATE admin_contact SET content=?,revision=revision+1 WHERE id=1').run(content);
      return { previous, replacement: get() };
    },
  };
}
