import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import {initializeContacts,validHubIdentity,syncHubIdentity} from '../accounts.mjs';
import {HubLogin} from '../cloud/hub-login.mjs';
import {hubAccount} from '../cloud/hub-ai.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('practice synchronizes phone-only identities and leaves ownership on the stable user ID',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL); CREATE TABLE owned_records(user_id TEXT REFERENCES users(id),value TEXT)');initializeContacts(db);
    const user={id:randomUUID(),name:'Synthetic phone',email:null,phone:'+8613800138000',admin:0,unverifiedContacts:['phone']};assert.equal(validHubIdentity(user),true);syncHubIdentity(db,user);db.prepare('INSERT INTO owned_records VALUES(?,?)').run(user.id,'frozen record');
    assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get(user.id).email,null);assert.equal(db.prepare('SELECT verified FROM user_phones WHERE user_id=?').get(user.id).verified,0);
    syncHubIdentity(db,{...user,name:'Updated',unverifiedContacts:[]});assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(db.prepare('SELECT user_id FROM owned_records').get().user_id,user.id);assert.ok(db.prepare('SELECT verified FROM user_phones WHERE user_id=?').get(user.id).verified>0);
  }finally{db.close();}
});

test('Hub identity reader and cloud AI account relay preserve a phone-only profile',async t=>{
  const user={id:randomUUID(),name:'Synthetic phone',email:null,phone:'+8613800138000',admin:0};
  const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/me');assert.equal(req.headers.cookie,'qfh_java_test='+'a'.repeat(64));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const reader=new HubLogin({practiceOrigin:'https://practice.example.test',hubOrigin:'https://hub.example.test',authPort:server.address().port,cookieName:'qfh_java_test'});const identity=await reader.identity('a'.repeat(64));assert.deepEqual(identity,user);
  const result=await hubAccount({manageUrl:'https://hub.example.test/manage/',call:async()=>({status:200,body:{user:identity,ai:{enabled:true,balance:42000}}})},{});assert.equal(result.user.email,null);assert.equal(result.user.phone,user.phone);assert.equal(result.ai.balance,42000);
});

test('legacy email schema upgrade preserves sessions, device credentials, AI balances and foreign key references', () => {
  const db = new DatabaseSync(':memory:'); const id = randomUUID();
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
    CREATE TABLE owned_records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER);
    CREATE TABLE connect_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token TEXT UNIQUE);
    CREATE TABLE ai_points(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL,updated INTEGER);
    CREATE INDEX keep_user_name ON users(name);`);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, 'old@example.test', 'old', 'unchanged-hash', 0, '2026-01-01');
  db.prepare('INSERT INTO owned_records VALUES (?,?,?)').run('record', id, 'synthetic saved record');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('session'), id, 9999999999999);
  db.prepare('INSERT INTO connect_devices VALUES (?,?,?)').run('device', id, hash('device-token'));
  db.prepare('INSERT INTO ai_points VALUES (?,?,?)').run(id, 88888, 1);
  const tables = ['users', 'owned_records', 'sessions', 'connect_devices', 'ai_points'], before = tables.map(table => db.prepare('SELECT * FROM ' + table).all());
  initializeContacts(db); initializeContacts(db);
  assert.deepEqual(tables.map(table => db.prepare('SELECT * FROM ' + table).all()), before);
  assert.equal(db.prepare('PRAGMA table_info(users)').all().find(column => column.name === 'email').notnull, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='keep_user_name'").get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.prepare('INSERT INTO owned_records VALUES (?,?,?)').run('bad', 'missing', 'x'));
  db.close();
});
