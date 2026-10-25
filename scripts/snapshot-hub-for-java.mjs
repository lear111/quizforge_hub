import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// An offline rehearsal tool. Never points Java at the live Node directory.
// Stop writes for the duration of the filesystem + DB snapshot so references
// cannot race uploads/deletes; the explicit option records that operator step.
export async function snapshot(source, target, { sourceStopped = false } = {}) {
  source=fs.realpathSync(source);target=path.resolve(target);
  if(!sourceStopped)throw new Error('Stop Hub writes first, then pass --source-stopped.');
  if(target===source||target.startsWith(source+path.sep)||source.startsWith(target+path.sep))throw new Error('Snapshot source and target must be separate directories.');
  if(fs.existsSync(target))throw new Error('Snapshot target already exists; never overwrite it.');
  const files=[];
  const enumerate=(directory,relative='')=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const name=path.join(relative,entry.name),full=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw new Error('Symlinks are not accepted in migration input.');
      if(entry.isDirectory())enumerate(full,name);else if(entry.isFile())files.push(name);else throw new Error('Unsupported migration input.');
    }
  };
  for(const folder of ['files','downloads'])if(fs.existsSync(path.join(source,folder))){if(fs.lstatSync(path.join(source,folder)).isSymbolicLink())throw new Error('Symlinks are not accepted in migration input.');enumerate(path.join(source,folder),folder);}
  const database=new DatabaseSync(path.join(source,'hub.sqlite'),{readOnly:true});
  try{
    if(database.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Source database integrity check failed.');
    fs.mkdirSync(target,{recursive:false});
    await backup(database,path.join(target,'hub.sqlite'));
    const copied={};
    for(const name of files){const full=path.join(source,name);if(fs.lstatSync(full).isSymbolicLink())throw new Error('Migration source changed.');fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});fs.copyFileSync(full,path.join(target,name),fs.constants.COPYFILE_EXCL);copied[name.split(path.sep).join('/')]=createHash('sha256').update(fs.readFileSync(full)).digest('hex');}
    const check=new DatabaseSync(path.join(target,'hub.sqlite'),{readOnly:true});
    try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Snapshot database validation failed.');}finally{check.close();}
    fs.writeFileSync(path.join(target,'java-migration-snapshot.json'),JSON.stringify({schemaVersion:1,sourceStopped:true,complete:true,files:copied},null,2)+'\n');
    return {complete:true,copiedFiles:files.length};
  }finally{database.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);if(args.length!==3||args[2]!=='--source-stopped')throw new Error('Usage: node scripts/snapshot-hub-for-java.mjs <stopped DATA_DIR> <new snapshot directory> --source-stopped');
  console.log(JSON.stringify(await snapshot(args[0],args[1],{sourceStopped:true})));
}
