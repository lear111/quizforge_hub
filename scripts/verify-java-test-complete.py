from pathlib import Path
from contextlib import closing
import hashlib, json, secrets, shutil, sqlite3, subprocess, time, urllib.request, urllib.error, urllib.parse, uuid

RELEASE=Path('/opt/quizforge-hub-java-test/releases/20261025-java-complete-e4af7fe')
DATA=Path('/var/lib/quizforge-hub-java-test')
PRACTICE=Path('/var/lib/quizforge-hub-practice')
HUB_BEFORE=Path('/var/backups/quizforge-hub-java-test/before-20261025-java-complete-e4af7fe/data')
PRACTICE_BEFORE=Path('/var/backups/quizforge-hub-practice/before-20261025-java-complete-e4af7fe/data')
HUB='https://quizforge-test.treenewbee.cloud'
SPACE='https://practice-test.treenewbee.cloud'
assert RELEASE.is_dir() and HUB_BEFORE.is_dir() and PRACTICE_BEFORE.is_dir()
# Server-only acceptance for this isolated test release and its stopped backups.
class Checks:
    @staticmethod
    def quoted(value): return '"'+value.replace('"','""')+'"'
    @staticmethod
    def row_digest(connection,table,columns):
        selected=','.join(Checks.quoted(c) for c in columns)
        def typed(value):
            return [type(value).__name__,value.hex() if isinstance(value,bytes) else value]
        rows=[json.dumps([typed(v) for v in row],ensure_ascii=False,separators=(',',':')) for row in connection.execute('SELECT '+selected+' FROM '+Checks.quoted(table))]
        return hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()
    @staticmethod
    def file_inventory(root):
        result={}
        for folder in ('files','downloads'):
            directory=root/folder
            if not directory.exists():continue
            for file in directory.rglob('*'):
                assert not file.is_symlink()
                if file.is_file():result[file.relative_to(root).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
        return result
    @staticmethod
    def state(unit,field='ActiveState'):
        return subprocess.check_output(['systemctl','show',unit,'-p',field,'--value'],text=True).strip()
helper=Checks()
manifest=json.loads((RELEASE/'source-manifest.json').read_text())
assert hashlib.sha256((RELEASE/'quizforge-hub.jar').read_bytes()).hexdigest()==manifest['jarSha256']
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
client=urllib.request.build_opener(NoRedirect)
def call(route,body=None,cookie=None,method=None,origin=HUB,raw=False,extra=None):
    headers={'Accept':'*/*' if raw else 'application/json','User-Agent':'QuizForge-Java-Complete-Test/1'}
    if cookie: headers['Cookie']=cookie
    if body is not None:
        headers['Origin']=origin
        headers['Content-Type']='application/json'
        body=json.dumps(body).encode() if not isinstance(body,bytes) else body
    if extra:headers.update(extra)
    request=urllib.request.Request(origin+route,data=body,method=method or ('POST' if body is not None else 'GET'),headers=headers)
    try:response=client.open(request,timeout=120)
    except urllib.error.HTTPError as error:response=error
    with response:
        data=response.read()
        value=data if raw or not data else json.loads(data) if 'application/json' in response.headers.get('Content-Type','') else data
        return response.status,value,response.headers
def ok(route,body=None,cookie=None,method=None,origin=HUB,expected=200,raw=False,extra=None):
    status,value,headers=call(route,body,cookie,method,origin,raw,extra)
    assert status==expected,(route,status,expected) # Never include response content or credentials in errors.
    return value,headers
def database(root,writable=False):
    c=sqlite3.connect((root/'hub.sqlite').as_uri()+('' if writable else '?mode=ro'),uri=not writable)
    c.execute('PRAGMA foreign_keys=ON');c.execute('PRAGMA busy_timeout=5000')
    return c
def digest(root):
    result={}
    for file in root.rglob('*'):
        assert not file.is_symlink()
        if not file.is_file():continue
        rel=file.relative_to(root).as_posix()
        if file.name in ('hub.sqlite','hub.sqlite-wal','hub.sqlite-shm','host.lock'):continue
        result[rel]=hashlib.sha256(file.read_bytes()).hexdigest()
    return result
def compare_rows(before,after,exclude=()):
    with closing(database(before)) as a,closing(database(after)) as b:
        tables=[r[0] for r in a.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        compared=0
        for table in tables:
            if table in exclude:continue
            columns=[r[1] for r in a.execute('PRAGMA table_info('+helper.quoted(table)+')') if not(table=='review_mail_state' and r[1]=='generation')]
            assert helper.row_digest(a,table,columns)==helper.row_digest(b,table,columns),'Original rows changed: '+table
            compared+=1
        assert b.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not b.execute('PRAGMA foreign_key_check').fetchall()
        return compared

report={'origin':HUB,'release':str(RELEASE),'jarSha256':manifest['jarSha256'],'realProviderCalls':False,'browserAcceptance':False,'productionChanged':False}
# Before introducing any test rows, all pre-upgrade records and files must match.
report['hubTablesBeforeAcceptance']=compare_rows(HUB_BEFORE,DATA)
report['practiceTablesBeforeAcceptance']=compare_rows(PRACTICE_BEFORE,PRACTICE)
assert helper.file_inventory(HUB_BEFORE)==helper.file_inventory(DATA)
practice_before_files=digest(PRACTICE_BEFORE)
practice_after_files=digest(PRACTICE)
for name,checksum in practice_before_files.items():assert practice_after_files.get(name)==checksum,'Original practice file changed: '+name
report['preUpgradeFilesPreserved']=True
with closing(database(DATA)) as c:
    original_users=c.execute('SELECT id,admin FROM users').fetchall()
    enabled=c.execute('SELECT enabled FROM official_ai_config WHERE id=1').fetchone()[0]
assert ok('/api/config')[0]['officialAi']['enabled']==bool(enabled)
for identity,admin_role in original_users:
    token=secrets.token_hex(32);hashed=hashlib.sha256(token.encode()).hexdigest()
    try:
        with closing(database(DATA,True)) as c:
            c.execute('INSERT INTO sessions VALUES(?,?,?)',(hashed,identity,int(time.time()*1000)+60000));c.commit()
        cookie='qfh_java_test='+token
        user=ok('/api/me',cookie=cookie)[0]['user'];assert user['id']==identity and bool(user['admin'])==bool(admin_role)
        mine=ok('/api/packs?mine=1',cookie=cookie)[0]
        with closing(database(DATA)) as c:
            owned={row[0] for row in c.execute('SELECT id FROM packs WHERE user_id=?',(identity,))}
        assert {p['id'] for p in mine['packs']}<=owned
        with closing(database(DATA)) as c:
            balance=c.execute('SELECT balance FROM ai_points WHERE user_id=?',(identity,)).fetchone()
        assert ok('/api/account/ai',cookie=cookie)[0]['balance']==(balance[0] if balance else 0)
    finally:
        with closing(database(DATA,True)) as c:c.execute('DELETE FROM sessions WHERE token=?',(hashed,));c.commit()
report['existingAccountsChecked']=len(original_users)
assert ok('/api/health')[0]['phase']=='hub-feature-parity'
caps=ok('/api/java/capabilities')[0]
assert {'review','admin-management','ai-gateway','practice-internal-api','local-import'}<=set(caps['native'])
assert caps['localImportEnabled'] is False # OS clients are pinned to the production origin.
assert call('/admin/',raw=True)[0]==303
for route in ('/api/admin/users','/api/admin/cloud/extensions','/api/account/ai'):assert call(route)[0]==401
assert call('/internal/ai/me')[0]==403
assert call('/api/activity',{'kind':'visit'},extra={'Origin':'https://evil.example'})[0]==403
report['anonymousAndInternalBoundaries']=True
for name in ('index.html','hub.js','account-ui.mjs','detail-ui.mjs','publishing-ui.mjs','admin/app.js','admin/ai.js','admin/admin.css','activity.js'):
    body,headers=ok('/' if name=='index.html' else '/'+name,raw=True)
    assert headers.get('X-QuizForge-Environment')=='java-test'
    expected=next(i['sha256'] for i in manifest['files'] if i['path'].endswith('/static/'+name))
    assert hashlib.sha256(body).hexdigest()==expected
report['sourceMatchedAssets']=9

people={};written=set();submission_ids=set();workspace=None;practice_cookie=None
queue_before=0;pack_id=None
try:
    with closing(database(DATA,True)) as c:
        queue_before=c.execute('SELECT generation FROM review_mail_state WHERE id=1').fetchone()[0]
        for role in ('admin','owner'):
            identity=str(uuid.uuid4());token=secrets.token_hex(32)
            people[role]={'id':identity,'cookie':'qfh_java_test='+token}
            c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',(identity,identity+'@example.test','Synthetic '+role,'!disabled-test-password',role=='admin',time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())))
            c.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),identity,int(time.time()*1000)+900000))
        c.commit()
    admin=people['admin']['cookie'];owner=people['owner']['cookie']
    assert call('/admin/',cookie=owner,raw=True)[0]==403
    shell,_=ok('/admin/',cookie=admin,raw=True);assert b'qf-admin' in shell
    overview,_=ok('/api/admin/overview',cookie=admin);assert isinstance(overview['cloud']['pendingExtensions'],int)
    users,_=ok('/api/admin/users',cookie=admin);assert any(u['id']==people['owner']['id'] for u in users['users'])
    for route in ('/api/admin/contact','/api/admin/invitations','/api/admin/reports','/api/admin/audit','/api/admin/official-ai','/api/admin/ai-codes'):ok(route,cookie=admin)
    assert isinstance(ok('/api/account/ai',cookie=owner)[0]['balance'],int)
    report['nativeAdminAndBalanceReads']=True

    # Real HTTPS SSO through Caddy, with state/verifier and single-use callback.
    _,_,headers=call('/auth/hub',origin=SPACE,raw=True)
    verifier=headers.get_all('Set-Cookie')[0].split(';')[0]
    authorize=urllib.parse.urlsplit(headers['Location']);assert authorize.scheme=='https' and authorize.netloc==urllib.parse.urlsplit(HUB).netloc
    status,_,headers=call(authorize.path+'?'+authorize.query,cookie=owner,raw=True);assert status==303
    callback=urllib.parse.urlsplit(headers['Location']);assert callback.netloc==urllib.parse.urlsplit(SPACE).netloc
    _,headers=ok(callback.path+'?'+callback.query,cookie=verifier,origin=SPACE,expected=303,raw=True)
    practice_cookie=next(v.split(';')[0] for v in headers.get_all('Set-Cookie') if v.startswith('__Host-qfh_practice='))
    assert ok('/api/me',cookie=practice_cookie,origin=SPACE)[0]['user']['id']==people['owner']['id']
    assert call(callback.path+'?'+callback.query,cookie=verifier,origin=SPACE,raw=True)[0]==400
    _,headers=ok('/',cookie=practice_cookie,origin=SPACE,expected=303,raw=True);workspace_route=headers['Location']
    workspace=workspace_route.rstrip('/').rsplit('/',1)[1];uuid.UUID(workspace)
    page,_=ok(workspace_route,cookie=practice_cookie,origin=SPACE,raw=True);assert b'user-center-panel' in page and b'cloud-storage-progress' in page
    ok('/api/cloud/me',cookie=practice_cookie,origin=SPACE)
    ok('/api/cloud/library',cookie=practice_cookie,origin=SPACE)
    assert call('/api/cloud/admin/users',cookie=practice_cookie,origin=SPACE)[0]==404
    contact,_=ok('/api/cloud/admin-contact',cookie=practice_cookie,origin=SPACE);assert isinstance(contact['content'],str)
    report['httpsSsoAndRealPracticeWorkspace']=True

    # Inspect a temporary basic package without approving or changing any existing whitelist digest.
    source=Path('/opt/quizforge-hub-practice/current/.runtime/web-current/basic-demo.qbank').read_bytes()
    boundary='qfh-'+secrets.token_hex(16)
    fields={'title':'Synthetic Java migration acceptance','summary':'Synthetic only','description':'Temporary pending package','version':'1.0','rights':'yes'}
    chunks=[]
    for key,value in fields.items():chunks.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+value+'\r\n').encode())
    chunks.extend([('--'+boundary+'\r\nContent-Disposition: form-data; name="archive"; filename="synthetic.qbank"\r\nContent-Type: application/octet-stream\r\n\r\n').encode(),source,('\r\n--'+boundary+'--\r\n').encode()])
    value,_=ok('/api/packs',b''.join(chunks),cookie=owner,expected=201,extra={'Content-Type':'multipart/form-data; boundary='+boundary})
    pack=value['pack'];pack_id=pack['id'];written.add(pack['archive']['id'])
    assert pack['status']=='pending' and call('/api/packs/'+pack_id)[0]==404
    inspected,_=ok('/api/admin/packs/'+pack_id+'/inspect',{},cookie=admin)
    submission_ids.add(inspected['item']['id']);assert inspected['item']['extensions']
    assert call('/api/admin/packs/'+pack_id+'/decision',{'decision':'approved','reason':'Synthetic must not auto approve','revision':1},cookie=admin)[0]==400
    ok('/api/admin/packs/'+pack_id+'/decision',{'decision':'rejected','reason':'Temporary migration acceptance','revision':1},cookie=admin)
    assert ok('/api/packs/'+pack_id,cookie=owner)[0]['pack']['status']=='rejected'
    ok('/api/packs/'+pack_id,{'revision':1},cookie=owner,method='DELETE')
    assert not (DATA/'files'/pack['archive']['id']).exists()
    report['pendingUploadImmutableInspectionRejectAndDelete']=True
    report['existingWhitelistNotChanged']=True

    public=ok('/api/packs')[0]['packs'][0];prefix='/api/packs/'+public['id']
    pinned,_=ok(prefix+'/local-import?revision='+str(public['revision']))
    assert pinned['archive']['sha256']==public['archive']['sha256']
    # A mismatching revision fails without charging or downloading the existing package.
    status,value,_=call(prefix+'/local-import?revision='+str(public['revision']+1));assert status==409 and value['code']=='LOCAL_IMPORT_REVISION_CHANGED'
    report['nativeFixedRevisionManifest']=True

    # Delete the temporary practice workspace through the real API before fixture cleanup.
    ok('/api/cloud/library/'+workspace,{},cookie=practice_cookie,method='DELETE',origin=SPACE)
    ok('/auth/logout',{},cookie=practice_cookie,origin=SPACE)
    assert ok('/api/me',cookie=owner)[0]['user'] is None
    report['centralLogoutRevokesHubSession']=True
finally:
    ids=[person['id'] for person in people.values()]
    # Remove only rows and directories belonging to the fresh random synthetic identities.
    with closing(database(PRACTICE,True)) as c:
        for person in ids:
            for row in c.execute('SELECT id FROM extension_submissions WHERE user_id=? OR reviewer=?',(person,person)):submission_ids.add(row[0])
            for table,column in [('cloud_workspace_members','user_id'),('cloud_imports','user_id'),('cloud_audit','actor_id'),('cloud_audit','user_id'),('cloud_accounts','user_id'),('cloud_storage_reservations','user_id'),('cloud_traffic','user_id'),('activity_daily','user_id'),('activity_online','user_id'),('sessions','user_id'),('user_phones','user_id')]:
                try:c.execute('DELETE FROM '+table+' WHERE '+column+'=?',(person,))
                except sqlite3.OperationalError as e:
                    if 'no such table' not in str(e):raise
            c.execute('DELETE FROM extension_submissions WHERE user_id=? OR reviewer=?',(person,person))
            c.execute('DELETE FROM users WHERE id=?',(person,))
        c.commit()
    for person in ids:
        target=(PRACTICE/'cloud-content/users'/person).resolve();assert target.parent==PRACTICE/'cloud-content/users';uuid.UUID(person)
        if target.exists():shutil.rmtree(target)
    for identity in submission_ids:
        uuid.UUID(identity);target=(PRACTICE/'extension-submissions'/identity).resolve();assert target.parent==PRACTICE/'extension-submissions'
        if target.exists():shutil.rmtree(target)
    with closing(database(DATA,True)) as c:
        for person in ids:
            c.execute('DELETE FROM pack_admin_reviews WHERE pack_id IN (SELECT id FROM packs WHERE user_id=?)',(person,))
            c.execute('DELETE FROM pack_reviews WHERE reviewer_id=?',(person,))
        for person in ids:
            for row in c.execute('SELECT f.id FROM files f JOIN packs p ON p.id=f.pack_id WHERE p.user_id=?',(person,)):written.add(row[0])
            for table,column in [('pack_cloud_approvals','actor_id'),('admin_audit','actor_id'),('sessions','user_id'),('activity_daily','user_id'),('activity_online','user_id')]:c.execute('DELETE FROM '+table+' WHERE '+column+'=?',(person,))
            c.execute('DELETE FROM packs WHERE user_id=?',(person,));c.execute('DELETE FROM users WHERE id=?',(person,))
        c.commit()
    for identity in written:uuid.UUID(identity);(DATA/'files'/identity).unlink(missing_ok=True)

report['hubTablesAfterAcceptance']=compare_rows(HUB_BEFORE,DATA,('review_mail_state',))
report['practiceTablesAfterAcceptance']=compare_rows(PRACTICE_BEFORE,PRACTICE)
with closing(database(DATA)) as c:
    assert c.execute('SELECT generation FROM review_mail_state WHERE id=1').fetchone()[0]==queue_before+1
    assert c.execute('SELECT COUNT(*) FROM users').fetchone()[0]==6
assert helper.file_inventory(HUB_BEFORE)==helper.file_inventory(DATA)
after_files=digest(PRACTICE)
for name,checksum in digest(PRACTICE_BEFORE).items():assert after_files.get(name)==checksum,'Original practice file changed: '+name
report['originalRecordsAttachmentsAndPracticeFilesPreserved']=True
report['temporaryRowsAndFilesRemoved']=True
report['reviewQueueIncrementsThisRun']=1
for unit,pid in [('quizforge-hub','1810627'),('caddy','12260')]:assert helper.state(unit)=='active' and helper.state(unit,'MainPID')==pid
assert hashlib.sha256(Path('/etc/caddy/Caddyfile').read_bytes()).hexdigest()=='288b5e39579f61074777e396f450cebbb0cead4666b25772db3bc7e03b4e6bd0'
(RELEASE/'complete-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
