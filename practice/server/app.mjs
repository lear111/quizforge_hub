import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CloudAccounts,CloudError} from './cloud/accounts.mjs';
import {CloudLibrary} from './cloud/library.mjs';
import {cloudRoute} from './cloud/routes.mjs';
import {ReviewPackages} from './admin/review-packages.mjs';
import {ActivityMetrics} from './admin/metrics.mjs';
import {initializeContacts,validHubIdentity,syncHubIdentity} from './accounts.mjs';
import {createAdminContact} from './admin-contact.mjs';
import {servePracticePwa} from './cloud/pwa.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),MiB=1048576;
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Retained Node practice runtime. Public marketplace, credentials and AI billing live in Java. */
export async function createPracticeApp(options={}){
  if(typeof options.identityProvider!=='function')throw new Error('Practice requires the Hub identity provider');
  const dataDir=path.resolve(options.dataDir||process.env.DATA_DIR||'');if(!options.dataDir&&!process.env.DATA_DIR)throw new Error('Dedicated practice data directory required');
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(dataDir,'hub.sqlite'));db.exec("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS traffic(period TEXT PRIMARY KEY,bytes INTEGER NOT NULL)");initializeContacts(db);
  const metrics=new ActivityMetrics(db,options.now),adminContact=createAdminContact(db);
  const cloudAccounts=new CloudAccounts(db,{...options.cloud,timeZone:options.cloud?.timeZone??process.env.BILLING_TIMEZONE??'Asia/Shanghai',siteStorageBytes:options.cloud?.siteStorageBytes??Number(process.env.CLOUD_SITE_STORAGE_MB||5120)*MiB,defaults:options.cloud?.defaults??{storageBytes:Number(process.env.CLOUD_STORAGE_MB||256)*MiB,dailyTrafficBytes:Number(process.env.CLOUD_DAILY_TRAFFIC_MB||256)*MiB,monthlyTrafficBytes:Number(process.env.CLOUD_MONTHLY_TRAFFIC_MB||1024)*MiB}});
  const runtime=options.cloudRuntimeDir??process.env.CLOUD_RUNTIME_DIR;
  let cloudLibrary;
  try{cloudLibrary=await CloudLibrary.create(db,cloudAccounts,dataDir,runtime,{unifiedWorkspace:!!options.practiceHome,hubAi:options.hubAi??null});}catch(error){db.close();throw error;}
  const reviewPackages=new ReviewPackages(cloudLibrary),limits=new Map(),publicOrigin=options.publicOrigin??process.env.PUBLIC_ORIGIN;
  const identity=req=>req.externalHubIdentity||null;
  const requireUser=req=>identity(req)||(()=>{throw new CloudError(401,'请先登录');})();
  const requireAdmin=req=>{const user=requireUser(req);if(!user.admin)throw new CloudError(403,'仅管理员可操作');return user;};
  const throttle=(req,group,max,userId='')=>{const key=group+':'+(userId||(process.env.TRUST_PROXY==='1'?String(req.headers['x-real-ip']||req.socket.remoteAddress):req.socket.remoteAddress)),now=Date.now();let record=limits.get(key);if(!record||record.until<now){if(limits.size>=10000){for(const [name,item] of limits)if(item.until<now)limits.delete(name);if(limits.size>=10000)throw new CloudError(503,'服务繁忙，请稍后再试');}record={count:0,until:now+60000};limits.set(key,record);}if(++record.count>max)throw new CloudError(429,'操作太频繁，请稍后再试');};
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const bodyJson=async req=>{let size=0,chunks=[];if(Number(req.headers['content-length'])>32768)throw new CloudError(413,'请求内容过大');for await(const chunk of req){size+=chunk.length;if(size>32768)throw new CloudError(413,'请求内容过大');chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new CloudError(400,'请求内容不是有效 JSON 对象');}};
  const reserveTraffic=(req,size,reserve=true)=>{
    if(!Number.isSafeInteger(size)||size<0)throw new CloudError(503,'文件大小无效');const now=new Date(),zone=process.env.BILLING_TIMEZONE||'Asia/Shanghai',month=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit'}).format(now),ip=process.env.TRUST_PROXY==='1'?String(req.headers['x-real-ip']||req.socket.remoteAddress):req.socket.remoteAddress,day=now.toISOString().slice(0,10)+':'+hash(ip||'');
    db.exec('BEGIN IMMEDIATE');try{const used=db.prepare('SELECT bytes FROM traffic WHERE period=?').get(month)?.bytes||0,daily=db.prepare('SELECT bytes FROM traffic WHERE period=?').get(day)?.bytes||0;if(used+size>Number(options.monthlyBudgetBytes??Number(process.env.MONTHLY_FILE_BUDGET_GB||150)*1e9))throw new CloudError(429,'本月附件下载预算已用完');if(daily+size>Number(process.env.IP_DAILY_FILE_MB||1000)*MiB)throw new CloudError(429,'今天的附件下载额度已用完');if(reserve){const user=identity(req);if(user)cloudAccounts.reserveTraffic(user.id,size,{transaction:false});for(const period of [month,day])db.prepare('INSERT INTO traffic VALUES(?,?) ON CONFLICT(period) DO UPDATE SET bytes=bytes+excluded.bytes').run(period,size);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}if(reserve)metrics.transfer(size);
  };
  const resolveCloudPack=options.resolveCloudPack||(()=>{throw new CloudError(503,'Hub 题库来源尚未配置');});
  const handleCloud=cloudRoute({accounts:cloudAccounts,library:cloudLibrary,reviewPackages,requireUser,requireAdmin,bodyJson,throttle,json,resolveCloudPack,reserveTraffic,hubAi:options.hubAi??null,adminContact:options.adminContactSource||adminContact.get});
  const assets={
    '/styles.css':['styles.css','text/css'],'/quizforge-icon.png':['quizforge-icon.png','image/png'],'/favicon.svg':['quizforge-icon.png','image/png'],'/admin-contact.js':['admin-contact.js','text/javascript'],'/admin-contact.css':['admin-contact.css','text/css'],'/cloud/admin-contact.css':['admin-contact.css','text/css'],'/cloud/activity.js':['activity.js','text/javascript'],'/cloud/library.js':['cloud/library.js','text/javascript'],'/cloud/import':['cloud/import.html','text/html'],'/cloud/import.js':['cloud/import.js','text/javascript'],'/cloud/import.css':['cloud/import.css','text/css'],'/cloud/':['cloud/index.html','text/html'],'/cloud/ai':['cloud/index.html','text/html'],
  };
  for(const name of ['app.js','vault.js','ai-client.js','ai-preferences.js','cloud.css','practice.css','experience.js','experience.css','embedded.css'])assets['/cloud/'+name]=['cloud/'+name,name.endsWith('.css')?'text/css':'text/javascript'];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; frame-src 'none'; style-src 'self'; img-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost'),pathname=decodeURIComponent(url.pathname);
      if(options.beforeRequest&&await options.beforeRequest(req,res,url))return;
      // Installation metadata is public and independent of Hub session health;
      // the existing host/SSO gate above still runs before these fixed assets.
      if(options.practiceHome&&servePracticePwa(req,res,pathname,cloudLibrary.runtime.core))return;
      const user=await options.identityProvider(req);if(user){if(!validHubIdentity(user))throw new CloudError(503,'Hub 登录信息无效');syncHubIdentity(db,user);req.externalHubIdentity=user;}
      if(pathname==='/cloud/admin'||pathname.startsWith('/api/cloud/admin/'))throw new CloudError(404,'页面不存在');
      if(pathname.startsWith('/api/auth/'))throw new CloudError(403,'请通过 Hub 统一登录');
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==(publicOrigin||'http://'+req.headers.host))throw new CloudError(403,'请求来源不受信任');
      if(options.practiceHome&&['/','/cloud/'].includes(pathname)&&req.method==='GET'){if(!user){res.writeHead(303,{Location:'/auth/hub','Cache-Control':'no-store'}).end();return;}const item=await cloudLibrary.ensureDemo(user.id);res.writeHead(303,{Location:'/cloud/practice/'+item.id+'/','Cache-Control':'no-store'}).end();return;}
      const practiceApi=/^\/api\/cloud\/practice\/([a-f0-9-]{36})(\/api\/.*)$/.exec(pathname),practicePage=/^\/cloud\/practice\/([a-f0-9-]{36})\/(.*)$/.exec(pathname);
      if(practiceApi||practicePage){
        if(options.practiceHome&&practicePage&&req.method==='GET'&&!user){res.writeHead(303,{Location:'/auth/hub','Cache-Control':'no-store'}).end();return;}
        const viewer=requireUser(req);throttle(req,'cloud-practice',240,viewer.id);if(practiceApi?.[2]==='/api/library/import'&&req.method==='POST')throttle(req,'cloud-import',6,viewer.id);
        if(options.practiceHome&&practicePage&&practicePage[2]===''){cloudLibrary.owned(viewer.id,practicePage[1]);const workspace=await cloudLibrary.ensureDemo(viewer.id);if(workspace.id!==practicePage[1]){res.writeHead(303,{Location:'/cloud/practice/'+workspace.id+'/'+url.search,'Cache-Control':'no-store'}).end();return;}}
        let result;
        if(practiceApi)result=await cloudLibrary.practice.api(viewer.id,practiceApi[1],practiceApi[2]+url.search,req);
        else{if(req.method!=='GET')throw new CloudError(405,'页面仅支持 GET');result=cloudLibrary.practice.asset(viewer.id,practicePage[1],practicePage[2],{ordinary:!!options.practiceHome});res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");}
        if(practiceApi&&['POST','PUT'].includes(req.method)&&result.status<400&&/\/(?:answer|answers|submit|exam|exams|actions)(?:\/|$)/.test(practiceApi[2]))options.reportActivity?.(req,'practice')?.catch(()=>{});
        res.writeHead(result.status,{'Content-Type':result.type,'Content-Length':result.bytes.length,'Cache-Control':'no-store'});res.end(result.bytes);return;
      }
      if(pathname==='/api/me'&&req.method==='GET'){json(res,200,{user});return;}
      if(pathname==='/api/config'&&req.method==='GET'){json(res,200,{maxArchiveMB:20,cloudEnabled:true,practiceOrigin:options.practiceOrigin??process.env.PRACTICE_ORIGIN??'',adminEnabled:false,registrationReady:false,officialAi:{enabled:false,protocolVersion:1}});return;}
      if(pathname==='/api/cloud/activity'&&req.method==='POST'&&options.reportActivity){const user=requireUser(req),input=await bodyJson(req);throttle(req,'activity-relay',40,user.id);if(!['visit','practice','heartbeat'].includes(input.kind))throw new CloudError(400,'活动类型无效');await options.reportActivity(req,input.kind);json(res,200,{ok:true});return;}
      if(await handleCloud(req,res,url))return;
      if(['GET','HEAD'].includes(req.method)&&assets[pathname]){
        const [name,type]=assets[pathname];let bytes=await fs.readFile(path.join(root,'public',name));
        if(options.practiceHome&&pathname==='/cloud/ai'&&url.searchParams.get('embedded')==='1'){const base=url.searchParams.get('base'),web=/^\/cloud\/practice\/[a-f0-9-]{36}$/.test(base||'')?`<link rel="stylesheet" href="${base}/ai/ai-settings.css">`:'';bytes=Buffer.from(bytes.toString('utf8').replace('<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/cloud/cloud.css">',web).replace('</head>','<link rel="stylesheet" href="/cloud/embedded.css"></head>'));res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'");}
        res.writeHead(200,{'Content-Type':type+(type.startsWith('image/')?'':'; charset=utf-8'),'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);return;
      }
      throw new CloudError(404,'页面不存在');
    }catch(error){req.resume();if(res.headersSent){res.destroy();return;}const status=error instanceof CloudError?error.status:error.code==='ENOENT'?404:500,scoped=/^\/api\/cloud\/practice\/[a-f0-9-]{36}\/api\//.test(req.url.split('?')[0]),message=status===500?'服务器暂时无法处理，请稍后重试':error.message;if(status===500)console.error('Practice request failed:',error.name);json(res,status,{error:scoped?{code:error.code||'CLOUD_REQUEST_REJECTED',message}:message});}
  });
  server.requestTimeout=135000;server.headersTimeout=10000;
  let closing;
  const close=()=>closing??=(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await cloudLibrary.close();db.close();})();
  return {server,dataDir,db,cloudLibrary,cloudAccounts,metrics,reviewPackages,close};
}
