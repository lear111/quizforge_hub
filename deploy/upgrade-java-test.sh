#!/bin/sh
# Updates only the already-installed Java test service. Never restores data automatically.
# Usage: sudo sh upgrade-java-test.sh STAGING RELEASE EXPECTED_CURRENT_JAR_SHA256
set -eu
stage=$(realpath "$1")
release=$2
expected=$3
base=/opt/quizforge-hub-java-test
data=/var/lib/quizforge-hub-java-test
case "$stage" in /tmp/java-stage2-deploy-*) ;; *) echo 'Unexpected staging directory' >&2;exit 1;;esac
case "$release" in *[!a-zA-Z0-9-]*|'') exit 1;;esac
test "$(id -u)" = 0
test "$(hostname)" = VM-0-12-ubuntu
test "$(realpath "$data")" = "$data"
old=$(readlink -f "$base/current")
case "$old" in "$base"/releases/*) ;; *) echo 'Unexpected current release' >&2;exit 1;;esac
test "$(sha256sum "$old/quizforge-hub.jar" | cut -d ' ' -f 1)" = "$expected"
destination=$base/releases/$release
backup=/var/backups/quizforge-hub-java-test/before-$release
test ! -e "$destination"
test ! -e "$backup"
install -d -m 0755 "$destination"
install -m 0644 "$stage/quizforge-hub.jar" "$stage/source-manifest.json" "$stage/verify-java-test-deployment.py" "$stage/verify-java-test-accounts.py" "$destination/"
python3 - "$destination" "$stage" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);s=pathlib.Path(sys.argv[2]);m=json.loads((p/'source-manifest.json').read_text())
assert hashlib.sha256((p/'quizforge-hub.jar').read_bytes()).hexdigest()==m['jarSha256'],'Uploaded JAR checksum mismatch'
for name in ('quizforge-hub-java-test.service','verify-java-test-deployment.py','verify-java-test-accounts.py'):
    expected=next(i['sha256'] for i in m['files'] if i['path'].endswith('/'+name))
    assert hashlib.sha256((s/name).read_bytes()).hexdigest()==expected,'Deployment input mismatch'
print('Staged account release hashes verified')
PY
install -d -m 0700 /var/backups/quizforge-hub-java-test "$backup"
cp -p /etc/systemd/system/quizforge-hub-java-test.service "$backup/service.before"
changed=0
finished=0
rollback() {
  code=$?
  if [ "$finished" != 1 ]; then
    echo 'Update failed; restoring previous binary and service, retaining all data' >&2
    systemctl stop quizforge-hub-java-test || true
    if [ "$changed" = 1 ]; then
      ln -s "$old" "$base/current.rollback-$release"
      mv -Tf "$base/current.rollback-$release" "$base/current"
      install -m 0644 "$backup/service.before" /etc/systemd/system/quizforge-hub-java-test.service
      systemctl daemon-reload
    fi
    systemctl start quizforge-hub-java-test || true
  fi
  exit "$code"
}
trap rollback EXIT
systemctl stop quizforge-hub-java-test
cp -a "$data" "$backup/data"
python3 - "$backup/data" <<'PY'
import pathlib,sqlite3,sys
from contextlib import closing
p=pathlib.Path(sys.argv[1])/'hub.sqlite'
with closing(sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)) as c:
    assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('Stopped Java test data copied and checked')
PY
ln -s "releases/$release" "$base/current.next-$release"
changed=1
mv -Tf "$base/current.next-$release" "$base/current"
install -m 0644 "$stage/quizforge-hub-java-test.service" /etc/systemd/system/quizforge-hub-java-test.service
systemd-analyze verify /etc/systemd/system/quizforge-hub-java-test.service
systemctl daemon-reload
systemctl start quizforge-hub-java-test
python3 - <<'PY'
import json,time,urllib.request
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:4338/api/health',timeout=2) as r: result=json.load(r)
        assert result.get('phase')=='hub-feature-parity'
        print('Java account service is healthy')
        break
    except Exception:
        if attempt==29: raise
        time.sleep(1)
PY
finished=1
echo "Updated Java test release: $destination"
echo "Stopped-data backup: $backup"
systemctl show quizforge-hub-java-test quizforge-hub quizforge-hub-practice caddy -p Id -p MainPID -p ActiveState
