// Contact details are login methods; the stable users.id owns devices and balances.
export const normalizePhone = value => {
  if (typeof value !== 'string' || value.length > 32) return null;
  const local = value.trim().replace(/[ -]/g, '').replace(/^(?:\+86|86)(?=1\d{10}$)/, '');
  return /^1[3-9]\d{9}$/.test(local) ? '+86' + local : null;
};
export function loginContact(input) {
  const entries = ['identifier', 'email', 'phone'].filter(key => input[key] !== undefined);
  if (entries.length !== 1 || typeof input[entries[0]] !== 'string') return null;
  const value = input[entries[0]].trim();
  if (entries[0] !== 'phone' && value.length <= 180 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { channel: 'email', value: value.toLowerCase() };
  const phone = entries[0] !== 'email' && normalizePhone(value);
  return phone ? { channel: 'phone', value: phone } : null;
}

export function initializeContacts(db) {
  // Rebuild only the legacy users table, without renaming its referenced name.
  // Keep IDs, sessions, foreign keys, AI balances and device token hashes intact.
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.find(column => column.name === 'email')?.notnull) {
    if (columns.map(column => column.name).join(',') !== 'id,email,name,password,admin,created') throw new Error('Unsupported users schema; contact migration requires review');
    const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE users_contact_migration(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
        INSERT INTO users_contact_migration SELECT id,email,name,password,admin,created FROM users;
        DROP TABLE users;
        ALTER TABLE users_contact_migration RENAME TO users;`);
      for (const extra of extras) db.exec(extra.sql);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Contact migration failed foreign key validation');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.exec('PRAGMA foreign_keys=ON'); }
  }
  db.exec('CREATE TABLE IF NOT EXISTS user_phones(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,phone TEXT UNIQUE NOT NULL,verified INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS unverified_contacts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,channel TEXT NOT NULL,contact TEXT NOT NULL,PRIMARY KEY(user_id,channel))');
}

export function accountByContact(db, contact) {
  return contact.channel === 'email' ? db.prepare('SELECT * FROM users WHERE email=?').get(contact.value)
    : db.prepare('SELECT u.* FROM users u JOIN user_phones p ON p.user_id=u.id WHERE p.phone=?').get(contact.value);
}
export function accountProfile(db, id) {
  const user = db.prepare('SELECT u.id,u.name,u.email,p.phone,u.admin FROM users u LEFT JOIN user_phones p ON p.user_id=u.id WHERE u.id=?').get(id);
  if (user) {
    const unverified = db.prepare('SELECT channel,contact FROM unverified_contacts WHERE user_id=?').all(id).filter(row => user[row.channel] === row.contact).map(row => row.channel);
    if (unverified.length) user.unverifiedContacts = unverified;
  }
  return user;
}
export function setContactVerified(db, id, contact, verified, now = Date.now()) {
  if (!db.isTransaction) throw new Error('Contact verification must share the account transaction');
  if (verified) db.prepare('DELETE FROM unverified_contacts WHERE user_id=? AND channel=? AND contact=?').run(id, contact.channel, contact.value);
  else db.prepare('INSERT INTO unverified_contacts VALUES (?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET contact=excluded.contact').run(id, contact.channel, contact.value);
  if (contact.channel === 'phone') db.prepare('UPDATE user_phones SET verified=? WHERE user_id=? AND phone=?').run(verified ? now : 0, id, contact.value);
}
export function validHubIdentity(user) {
  return !!user && /^[a-f0-9-]{36}$/.test(user.id) && typeof user.name === 'string' && user.name.length <= 200 && [0, 1].includes(user.admin)
    && (user.email === null || typeof user.email === 'string' && user.email.length <= 200)
    && (user.phone == null || normalizePhone(user.phone) === user.phone)
    && (user.unverifiedContacts === undefined || Array.isArray(user.unverifiedContacts) && user.unverifiedContacts.length <= 2 && user.unverifiedContacts.every(channel => ['email', 'phone'].includes(channel)))
    && (!!user.email || !!user.phone);
}
export function syncHubIdentity(db, user) {
  if (!validHubIdentity(user)) throw new Error('Invalid Hub identity');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO users(id,email,name,password,admin,created) VALUES (?,?,?,'!external-auth',?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,admin=excluded.admin").run(user.id, user.email, user.name, user.admin, new Date().toISOString());
    if (user.phone) db.prepare('INSERT INTO user_phones VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone').run(user.id, user.phone, Date.now());
    else db.prepare('DELETE FROM user_phones WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM unverified_contacts WHERE user_id=?').run(user.id);
    for (const channel of user.unverifiedContacts || []) if (user[channel]) setContactVerified(db, user.id, { channel, value: user[channel] }, false);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
