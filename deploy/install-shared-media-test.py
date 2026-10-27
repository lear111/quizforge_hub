#!/usr/bin/env python3
"""Add only the TEST site's static media route, validating before graceful Caddy reload."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time

ROOT = Path('/var/lib/quizforge-shared-media-test')
TOOLS = Path('/usr/local/lib/quizforge-shared-media-test')
SNIPPET = Path('/etc/caddy/quizforge-shared-media-test.caddy')
CONFIG = Path('/etc/caddy/Caddyfile')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def service_state():
    names = ['quizforge-hub-java-test', 'quizforge-hub', 'quizforge-hub-practice', 'caddy']
    return {name: run('systemctl', 'show', name, '-p', 'MainPID', '-p', 'ActiveState').stdout.strip() for name in names}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--expected-caddy-sha256', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or socket.gethostname() != 'VM-0-12-ubuntu':
        raise ValueError('Designated TEST host/root only')
    stage = Path(args.stage)
    if stage.parent != Path('/tmp') or not re.fullmatch(r'quizforge-shared-media-[a-zA-Z0-9-]+', stage.name) or stage.resolve() != stage:
        raise ValueError('Unexpected staging path')
    manifest = json.loads((stage / 'manifest.json').read_text())
    for name in ['publish-shared-audio.py', 'shared-media-test.caddy']:
        p = stage / name
        if p.is_symlink() or sha(p.read_bytes()) != manifest[name]:
            raise ValueError('Staged file digest mismatch')
    before = CONFIG.read_bytes()
    if sha(before) != args.expected_caddy_sha256:
        raise ValueError('Caddy changed since preflight; inspect again')
    text = before.decode()
    blocks = list(re.finditer(r'(?ms)^quizforge-test\.treenewbee\.cloud\s*\{\n.*?^\}', text))
    if len(blocks) != 1 or 'shared-media' in blocks[0].group() or SNIPPET.exists():
        raise ValueError('Expected one unmodified test site without shared media')
    for directory, mode in [(ROOT, 0o755), (ROOT / 'audio', 0o755), (ROOT / '.incoming', 0o700), (TOOLS, 0o755)]:
        if directory.resolve() != directory or directory.is_symlink():
            raise ValueError('Unexpected symlink directory')
        if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
            raise ValueError('Expected a new or empty directory')
        directory.mkdir(exist_ok=True, mode=mode)
        directory.chmod(mode)
    target = TOOLS / 'publish.py'
    target.write_bytes((stage / 'publish-shared-audio.py').read_bytes())
    target.chmod(0o644)
    SNIPPET.write_bytes((stage / 'shared-media-test.caddy').read_bytes())
    SNIPPET.chmod(0o644)
    marker = '\timport ' + str(SNIPPET) + '\n'
    block = blocks[0].group()
    updated = block.replace('{\n', '{\n' + marker, 1)
    after = (text[:blocks[0].start()] + updated + text[blocks[0].end():]).encode()
    if after.replace(marker.encode(), b'', 1) != before:
        raise ValueError('Unexpected changes outside test-route import')
    suffix = time.strftime('%Y%m%d-%H%M%S', time.gmtime())
    backup = CONFIG.with_name('Caddyfile.before-shared-media-test-' + suffix)
    candidate = CONFIG.with_name('Caddyfile.shared-media-test-' + suffix)
    with backup.open('xb') as output:
        output.write(before)
    backup.chmod(0o600)
    with candidate.open('xb') as output:
        output.write(after)
    shutil.copystat(CONFIG, candidate)
    run('/usr/bin/caddy', 'validate', '--adapter', 'caddyfile', '--config', str(candidate))
    state_before = service_state()
    if CONFIG.read_bytes() != before:
        raise ValueError('Caddy changed during validation; no replacement made')
    os.replace(candidate, CONFIG)
    try:
        run('systemctl', 'reload', 'caddy')
    except Exception:
        if CONFIG.read_bytes() == after:
            CONFIG.write_bytes(before)
            run('systemctl', 'reload', 'caddy')
        raise
    state_after = service_state()
    if state_before != state_after:
        raise ValueError('Unexpected application service state/PID change; inspect')
    evidence = {'environment': 'test', 'origin': 'https://quizforge-test.treenewbee.cloud',
                'root': str(ROOT), 'publisher': str(target), 'backup': str(backup),
                'beforeCaddySha256': sha(before), 'afterCaddySha256': sha(after),
                'snippetSha256': sha(SNIPPET.read_bytes()), 'publisherSha256': sha(target.read_bytes()),
                'servicesBefore': state_before, 'servicesAfter': state_after}
    (stage / 'deployment.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    main()
