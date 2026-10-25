#!/bin/sh
# Coordinated TEST-only cutover. Run after confirmation that practice inputs are saved.
# Usage: sudo sh upgrade-java-practice-test.sh STAGE RELEASE OLD_JAR_SHA OLD_PRACTICE_ENTRY_SHA
set -eu
stage=$(realpath "$1")
release=$2
old_jar_sha=$3
old_entry_sha=$4
test "$(id -u)" = 0
test "$(hostname)" = VM-0-12-ubuntu
case "$stage" in /tmp/java-stage2-deploy-*) ;; *) exit 1;; esac
case "$release" in *[!a-zA-Z0-9-]*|'') exit 1;; esac
exec 9>/run/lock/quizforge-hub-java-test-deploy.lock
flock -n 9
java_base=/opt/quizforge-hub-java-test
practice_base=/opt/quizforge-hub-practice
practice_data=/var/lib/quizforge-hub-practice
old_java=$(readlink -f "$java_base/current")
old_practice=$(readlink -f "$practice_base/current")
case "$old_java" in "$java_base"/releases/*) ;; *) exit 1;; esac
case "$old_practice" in "$practice_base"/releases/*) ;; *) exit 1;; esac
test "$(realpath "$practice_data")" = "$practice_data"
test "$(sha256sum "$old_java/quizforge-hub.jar" | cut -d ' ' -f 1)" = "$old_jar_sha"
test "$(sha256sum "$old_practice/scripts/cloud-practice-site.mjs" | cut -d ' ' -f 1)" = "$old_entry_sha"
destination=$practice_base/releases/$release
backup=/var/backups/quizforge-hub-practice/before-$release
dropin=/etc/systemd/system/quizforge-hub-practice.service.d/30-java-hub.conf
test ! -e "$destination"
test ! -e "$backup"
test ! -e "$dropin"
install -d -m 0755 "$destination"
python3 - "$stage" "$destination" <<'PY'
import hashlib,json,pathlib,sys,tarfile
s=pathlib.Path(sys.argv[1]);d=pathlib.Path(sys.argv[2]);m=json.loads((s/'practice-manifest.json').read_text())
archive=s/'practice-source.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==m['archiveSha256']
expected={i['path']:i for i in m['files']}
with tarfile.open(archive) as t:
    members=t.getmembers()
    assert len(members)==len(expected)
    for i in members:
        assert i.isfile() and i.name in expected and not i.name.startswith('/') and '..' not in pathlib.PurePosixPath(i.name).parts
    t.extractall(d,filter='data')
for name,item in expected.items():
    p=d/name
    assert p.is_file() and not p.is_symlink() and p.stat().st_size==item['bytes'] and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']
assert not (d/'server.mjs').exists() and not (d/'test').exists()
print('Practice-only archive hashes and extraction boundary verified')
PY
test -f "$old_practice/.runtime/web-current/basic-demo.qbank"
case "$(realpath "$old_practice/.runtime/web-current")" in "$old_practice"/.runtime/*) ;; *) exit 1;; esac
install -d -m 0755 "$destination/.runtime"
cp -a "$old_practice/.runtime/web-current" "$destination/.runtime/web-current"
cp "$stage/practice-manifest.json" "$destination/"
python3 - "$old_practice/.runtime/web-current" "$destination/.runtime/web-current" <<'PY'
import hashlib,pathlib,sys
def inventory(root):
    root=pathlib.Path(root)
    result={}
    for p in root.rglob('*'):
        assert not p.is_symlink(),'Unexpected runtime link'
        if p.is_file(): result[p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
    return result
a,b=map(inventory,sys.argv[1:]);assert a==b
print('Retained Linux practice runtime verified:',len(a),'files')
PY
install -d -m 0700 /var/backups/quizforge-hub-practice "$backup"
systemctl cat quizforge-hub-practice > "$backup/service.before"
cp -p /etc/systemd/system/quizforge-hub-java-test.service "$backup/java-service.before"
printf '%s\n' "$old_java" > "$backup/java-release.before"
printf '%s\n' "$old_practice" > "$backup/practice-release.before"
finished=0
practice_changed=0
java_changed=0
rollback() {
  code=$?
  if [ "$finished" != 1 ]; then
    echo 'Cutover failed: restoring previous binaries/configuration, keeping all current data' >&2
    if [ "$practice_changed" = 1 ]; then
      systemctl stop quizforge-hub-practice || true
      ln -s "$old_practice" "$practice_base/current.rollback-$release"
      mv -Tf "$practice_base/current.rollback-$release" "$practice_base/current"
      rm -f "$dropin"
    fi
    if [ "$java_changed" = 1 ]; then
      systemctl stop quizforge-hub-java-test || true
      ln -s "$old_java" "$java_base/current.rollback-$release"
      mv -Tf "$java_base/current.rollback-$release" "$java_base/current"
      install -m 0644 "$backup/java-service.before" /etc/systemd/system/quizforge-hub-java-test.service
    fi
    systemctl daemon-reload
    systemctl start quizforge-hub-java-test quizforge-hub-practice || true
  fi
  exit "$code"
}
trap rollback EXIT
sh "$stage/upgrade-java-test.sh" "$stage" "$release" "$old_jar_sha"
java_changed=1
systemctl stop quizforge-hub-practice
practice_changed=1
cp -a "$practice_data" "$backup/data"
python3 - "$backup/data" <<'PY'
import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1])/'hub.sqlite'
with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True) as c:
    assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('Stopped practice data copied and checked')
PY
ln -s "releases/$release" "$practice_base/current.next-$release"
mv -Tf "$practice_base/current.next-$release" "$practice_base/current"
printf '%s\n' '[Service]' 'Environment=HUB_AUTH_PORT=4338' 'Environment=HUB_SESSION_COOKIE=qfh_java_test' > "$dropin"
chmod 0644 "$dropin"
systemctl daemon-reload
systemctl start quizforge-hub-practice
python3 - <<'PY'
import json,time,urllib.request,urllib.error
for attempt in range(30):
    try:
        with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4323/api/config',headers={'Host':'practice-test.treenewbee.cloud'}),timeout=2) as r: result=json.load(r)
        assert result['cloudEnabled'] is True
        try: urllib.request.urlopen('http://127.0.0.1:4324/summary',timeout=2)
        except urllib.error.HTTPError as error: assert error.code==401
        else: raise AssertionError('Unauthenticated private bridge was accepted')
        print('Independent practice service and private authentication boundary are healthy')
        break
    except Exception:
        if attempt==29: raise
        time.sleep(1)
PY
finished=1
printf 'Java and independent practice TEST release: %s\nPractice backup: %s\n' "$release" "$backup"
systemctl show quizforge-hub-java-test quizforge-hub-practice quizforge-hub caddy -p Id -p MainPID -p ActiveState
