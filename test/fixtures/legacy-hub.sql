-- Synthetic schema snapshot from Node Hub e4af7fe; data only, no executable Node backend.
CREATE TABLE activity_daily(day TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),practiced INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,user_id));
CREATE TABLE activity_online(user_id TEXT PRIMARY KEY REFERENCES users(id),last_seen INTEGER NOT NULL);
CREATE TABLE activity_transfers(day TEXT PRIMARY KEY,requests INTEGER NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE admin_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),target TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE admin_contact(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE admin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE ai_points (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE ai_points_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, created INTEGER NOT NULL);
CREATE TABLE ai_redeem_codes (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, points INTEGER NOT NULL, note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER, redeemed INTEGER, user_id TEXT REFERENCES users(id), code_cipher TEXT, seq INTEGER);
CREATE TABLE ai_signup_bonus (id INTEGER PRIMARY KEY CHECK(id=1), amount INTEGER NOT NULL CHECK(amount>=0));
CREATE TABLE ai_upstreams (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, position INTEGER NOT NULL, note TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, key_cipher TEXT NOT NULL, key_hint TEXT NOT NULL,
      input_price INTEGER NOT NULL, output_price INTEGER NOT NULL, remaining INTEGER, expires INTEGER, enabled INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, status_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
      spent INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE authentication_policy(id INTEGER PRIMARY KEY CHECK(id=1),login_code INTEGER NOT NULL,login_captcha INTEGER NOT NULL,registration_code INTEGER NOT NULL,registration_captcha INTEGER NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE cloud_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), limits_json TEXT NOT NULL, storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes>=0));
CREATE TABLE cloud_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), user_id TEXT REFERENCES users(id), action TEXT NOT NULL, previous TEXT NOT NULL, replacement TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE cloud_defaults (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE cloud_storage_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), bytes INTEGER NOT NULL CHECK(bytes>=0), expires INTEGER NOT NULL);
CREATE TABLE cloud_traffic (user_id TEXT NOT NULL REFERENCES users(id), period TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(user_id,period));
CREATE TABLE comments (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE connect_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, device_name TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE connect_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, client TEXT NOT NULL, created TEXT NOT NULL, last_used INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE contact_codes(channel TEXT NOT NULL,subject TEXT NOT NULL,nonce TEXT NOT NULL,digest TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL, captcha_verified INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(channel,subject));
CREATE TABLE contact_sends(id TEXT PRIMARY KEY,channel TEXT NOT NULL,address_key TEXT NOT NULL,ip_key TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE email_codes (email_key TEXT PRIMARY KEY, nonce TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, captcha_verified INTEGER NOT NULL DEFAULT 1);
CREATE TABLE email_sends (id TEXT PRIMARY KEY, email_key TEXT NOT NULL, ip_key TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE files (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
CREATE TABLE invitation_audit (
    id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
    actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE invitations (
    id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
    expires INTEGER NOT NULL, revoked INTEGER, used INTEGER,
    user_id TEXT UNIQUE REFERENCES users(id));
CREATE TABLE official_ai_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, model TEXT NOT NULL, daily_limit INTEGER NOT NULL, monthly_tokens INTEGER NOT NULL, key_cipher TEXT, key_hint TEXT, updated INTEGER NOT NULL, updated_by TEXT);
CREATE TABLE official_ai_usage (user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE pack_admin_reviews(pack_id TEXT NOT NULL,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,submission TEXT NOT NULL,PRIMARY KEY(pack_id,revision,sha256));
CREATE TABLE pack_cloud_approvals(pack_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,digests TEXT NOT NULL,status TEXT NOT NULL,actor_id TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE pack_reviews (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL, reviewer_id TEXT NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE packs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, summary TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, tags TEXT NOT NULL, version TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 1, review_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT, reviewed_at TEXT);
CREATE TABLE registration_policy(id INTEGER PRIMARY KEY CHECK(id=1),required INTEGER NOT NULL CHECK(required IN (0,1)));
CREATE TABLE reports (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE review_mail_attempts (created INTEGER NOT NULL);
CREATE TABLE review_mail_state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, sent_generation INTEGER NOT NULL, retry_after INTEGER NOT NULL, last_sent INTEGER NOT NULL, last_error TEXT NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE traffic (period TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE unverified_contacts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,channel TEXT NOT NULL,contact TEXT NOT NULL,PRIMARY KEY(user_id,channel));
CREATE TABLE user_blocks(user_id TEXT PRIMARY KEY REFERENCES users(id),actor_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE user_phones(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,phone TEXT UNIQUE NOT NULL,verified INTEGER NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
CREATE INDEX cloud_storage_owner ON cloud_storage_reservations(user_id);
CREATE INDEX comments_pack ON comments(pack_id, created);
CREATE INDEX connect_devices_user ON connect_devices(user_id, revoked);
CREATE INDEX contact_sends_address ON contact_sends(channel,address_key,created);
CREATE INDEX contact_sends_ip ON contact_sends(channel,ip_key,created);
CREATE INDEX email_sends_email ON email_sends(email_key,created);
CREATE INDEX email_sends_ip ON email_sends(ip_key,created);
CREATE INDEX email_sends_time ON email_sends(created);
CREATE INDEX files_pack ON files(pack_id);
CREATE INDEX packs_updated ON packs(updated);
INSERT INTO registration_policy(id,required) VALUES(1,0);
INSERT INTO authentication_policy(id,login_code,login_captcha,registration_code,registration_captcha,revision) VALUES(1,0,0,1,1,0);
INSERT INTO ai_signup_bonus(id,amount) VALUES(1,0);
INSERT INTO cloud_defaults(id,value) VALUES(1,'{"storageBytes":268435456,"dailyTrafficBytes":268435456,"monthlyTrafficBytes":1073741824}');
INSERT INTO admin_contact(id,content,revision) VALUES(1,'',0);
INSERT INTO admin_meta(key,value) VALUES('metrics-start','1792936472763');
