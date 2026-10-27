export class ActivityMetrics {
  constructor(db, now = Date.now) {
    this.db = db; this.now = now; this.started = now();
    this.format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    db.exec(`CREATE TABLE IF NOT EXISTS admin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_blocks(user_id TEXT PRIMARY KEY REFERENCES users(id),actor_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_daily(day TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),practiced INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,user_id));
      CREATE TABLE IF NOT EXISTS activity_online(user_id TEXT PRIMARY KEY REFERENCES users(id),last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_transfers(day TEXT PRIMARY KEY,requests INTEGER NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),target TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO admin_meta VALUES ('metrics-start',?)").run(String(now()));
  }
  day(time = this.now()) { return this.format.format(new Date(time)); }
  record(userId, kind) {
    const now = this.now();
    this.db.prepare('INSERT INTO activity_online VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen').run(userId, now);
    if (kind === 'visit' || kind === 'practice') this.db.prepare('INSERT INTO activity_daily VALUES (?,?,?) ON CONFLICT(day,user_id) DO UPDATE SET practiced=MAX(practiced,excluded.practiced)').run(this.day(), userId, kind === 'practice' ? 1 : 0);
  }
  transfer(size) { this.db.prepare('INSERT INTO activity_transfers VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1,bytes=bytes+excluded.bytes').run(this.day(), size); }
  overview(days = 7) {
    days = days === 30 ? 30 : 7;
    const day = this.day(), db = this.db;
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const online = db.prepare('SELECT COUNT(*) AS n FROM activity_online o WHERE last_seen>? AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.user_id=o.user_id)').get(this.now() - 300000).n;
    const trend = Array.from({ length: days }, (_, i) => {
      const date = new Date(day + 'T00:00:00+08:00').getTime() - (days - 1 - i) * 86400000, key = this.day(date);
      const active = db.prepare('SELECT COUNT(*) AS active,COALESCE(SUM(practiced),0) AS practice FROM activity_daily WHERE day=?').get(key);
      const start = new Date(date).toISOString(), end = new Date(date + 86400000).toISOString();
      return { day: key, ...active, registered: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created>=? AND created<?').get(start, end).n };
    });
    return { total, online, today: trend.at(-1), trend, transfers: db.prepare('SELECT requests,bytes FROM activity_transfers WHERE day=?').get(day) || { requests: 0, bytes: 0 }, pendingPacks: db.prepare("SELECT COUNT(*) AS n FROM packs WHERE status='pending'").get().n, reportingSince: Number(db.prepare("SELECT value FROM admin_meta WHERE key='metrics-start'").get().value), timezone: 'Asia/Shanghai', onlineWindowSeconds: 300 };
  }
}
