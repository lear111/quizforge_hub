// A durable, coalescing admin reminder. Never sends uploader-supplied content.
export function createReviewNotifications(db, provider, email, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_mail_state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, sent_generation INTEGER NOT NULL, retry_after INTEGER NOT NULL, last_sent INTEGER NOT NULL, last_error TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_mail_attempts (created INTEGER NOT NULL);
    INSERT OR IGNORE INTO review_mail_state VALUES (1,0,0,0,0,'')`);
  // Existing packs need one reminder after the migration, including across restarts.
  const initial = db.prepare('SELECT * FROM review_mail_state WHERE id=1').get();
  if (initial.generation === 0 && db.prepare("SELECT COUNT(*) AS n FROM packs WHERE status='pending'").get().n) db.prepare('UPDATE review_mail_state SET generation=1 WHERE id=1').run();
  const ready = !!(provider.reviewReady && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  let running = false, stopped = false;
  const wake = async () => {
    if (!ready || running || stopped) return;
    const state = db.prepare('SELECT * FROM review_mail_state WHERE id=1').get(), time = now();
    if (state.generation <= state.sent_generation || time < state.retry_after) return;
    if (!db.prepare("SELECT COUNT(*) AS n FROM packs WHERE status='pending'").get().n) {
      db.prepare('UPDATE review_mail_state SET sent_generation=generation WHERE id=1').run(); return;
    }
    db.prepare('DELETE FROM review_mail_attempts WHERE created<=?').run(time - 86400000);
    if (db.prepare('SELECT COUNT(*) AS n FROM review_mail_attempts').get().n >= 24) return;
    running = true;
    // Reserve before awaiting delivery; failures and restarts cannot reset the cap.
    db.prepare('INSERT INTO review_mail_attempts VALUES (?)').run(time);
    db.prepare('UPDATE review_mail_state SET retry_after=? WHERE id=1').run(time + 900000);
    try {
      await provider.sendReviewAlert(email);
      if (!stopped) db.prepare("UPDATE review_mail_state SET sent_generation=?,last_sent=?,last_error='' WHERE id=1").run(state.generation, now());
    } catch {
      if (!stopped) db.prepare("UPDATE review_mail_state SET retry_after=?,last_error='发送失败，将自动重试' WHERE id=1").run(now() + 1800000);
    } finally { running = false; }
  };
  const timer = setInterval(wake, 60000); timer.unref();
  return {
    wake,
    enqueue() { db.prepare('UPDATE review_mail_state SET generation=generation+1 WHERE id=1').run(); },
    state() { const row = db.prepare('SELECT * FROM review_mail_state WHERE id=1').get(); return { ready, lastSent: row.last_sent || null, error: row.last_error, queued: row.generation > row.sent_generation }; },
    stop() { stopped = true; clearInterval(timer); },
  };
}
