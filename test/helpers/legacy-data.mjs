// Synthetic legacy data format only. Does not contain or launch an old Hub server.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function legacyDatabase(directory){
  fs.mkdirSync(path.join(directory,'files'),{recursive:true});
  const db=new DatabaseSync(path.join(directory,'hub.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(fs.readFileSync(new URL('../fixtures/legacy-hub.sql',import.meta.url),'utf8'));
  return db;
}
