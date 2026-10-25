#!/bin/sh
# Run as root only on the designated Seoul TEST server after copying staged files.
# Usage: sh install-java-test.sh /tmp/java-test-deploy-YYYYMMDD-HHMMSS RELEASE
set -eu
stage=$(realpath "$1")
release=$2
case "$stage" in /tmp/java-test-deploy-*) ;; *) echo 'Unexpected staging path' >&2; exit 1;; esac
case "$release" in *[!a-zA-Z0-9-]*|'') echo 'Invalid release name' >&2; exit 1;; esac
base=/opt/quizforge-hub-java-test
destination=$base/releases/$release
data=/var/lib/quizforge-hub-java-test
test "$(id -u)" = 0
test "$(hostname)" = VM-0-12-ubuntu
test ! -e "$destination"
test ! -e "$base/current"
test ! -e "$data"
test -x /usr/bin/java
if ss -ltn | grep -q '127.0.0.1:4338 '; then echo 'Port 4338 is occupied' >&2; exit 1; fi
if ! getent passwd quizforge-java-test >/dev/null; then useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin quizforge-java-test; fi
install -d -m 0755 "$base/releases" "$destination"
install -m 0644 "$stage/quizforge-hub.jar" "$stage/schema.sql" "$stage/seed-java-public-preview.py" "$stage/source-manifest.json" "$destination/"
python3 - "$destination" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1])
m=json.loads((p/'source-manifest.json').read_text())
assert hashlib.sha256((p/'quizforge-hub.jar').read_bytes()).hexdigest()==m['jarSha256'], 'Uploaded JAR checksum mismatch'
for name in ('schema.sql','seed-java-public-preview.py'):
    expected=next(i['sha256'] for i in m['files'] if i['path'].endswith('/'+name))
    assert hashlib.sha256((p/name).read_bytes()).hexdigest()==expected, 'Staged source checksum mismatch'
print('JAR and data preparation source checksums verified')
PY
python3 "$destination/seed-java-public-preview.py" /var/lib/quizforge-hub "$data" --schema "$destination/schema.sql"
chown -R quizforge-java-test:quizforge-java-test "$data"
ln -s "releases/$release" "$base/current"
install -m 0644 "$stage/quizforge-hub-java-test.service" /etc/systemd/system/quizforge-hub-java-test.service
systemd-analyze verify /etc/systemd/system/quizforge-hub-java-test.service
systemctl daemon-reload
systemctl enable --now quizforge-hub-java-test.service
python3 - <<'PY'
import json,time,urllib.request
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:4338/api/health', timeout=2) as response:
            health=json.load(response)
        assert health.get('runtime')=='java',health
        print('Java loopback health verified')
        break
    except Exception:
        if attempt==29: raise
        time.sleep(1)
PY
python3 - "$release" <<'PY'
import hashlib,os,pathlib,re,shutil,subprocess,sys
p=pathlib.Path('/etc/caddy/Caddyfile')
before=p.read_bytes()
text=before.decode()
pattern=r'(?ms)^quizforge-test\.treenewbee\.cloud \{\n.*?^\}'
blocks=list(re.finditer(pattern,text))
assert len(blocks)==1,'Expected exactly one test domain block'
block=blocks[0].group()
assert block.count('reverse_proxy 127.0.0.1:4318 {')==1,'Test Hub upstream changed; inspect first'
updated=block.replace('reverse_proxy 127.0.0.1:4318 {','reverse_proxy 127.0.0.1:4338 {',1)
updated=updated.replace('\tencode zstd gzip','\tencode zstd gzip\n\theader X-QuizForge-Environment "java-test"',1)
after=(text[:blocks[0].start()]+updated+text[blocks[0].end():]).encode()
backup=p.with_name('Caddyfile.before-java-preview-'+sys.argv[1])
with backup.open('xb') as f: f.write(before)
shutil.copystat(p,backup)
candidate=p.with_name('Caddyfile.java-preview-'+sys.argv[1])
with candidate.open('xb') as f:f.write(after)
shutil.copystat(p,candidate)
subprocess.run(['/usr/bin/caddy','validate','--adapter','caddyfile','--config',str(candidate)],check=True)
assert p.read_bytes()==before,'Caddy configuration changed during validation; no replacement made'
os.replace(candidate,p)
try:
    subprocess.run(['systemctl','reload','caddy'],check=True)
except Exception:
    if p.read_bytes()==after:
        p.write_bytes(before)
        subprocess.run(['systemctl','reload','caddy'],check=True)
    raise
print('Only test-domain Hub upstream changed; backup:',backup)
print('Caddy configuration SHA256:',hashlib.sha256(after).hexdigest())
PY
systemctl show quizforge-hub-java-test quizforge-hub quizforge-hub-practice caddy -p Id -p MainPID -p ActiveState
