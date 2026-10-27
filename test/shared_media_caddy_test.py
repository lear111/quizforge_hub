"""Run on Linux with installed Caddy: isolated loopback only; never edits /etc/caddy."""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave

REPO = Path(__file__).resolve().parent.parent
base = REPO / '.temp'
base.mkdir(parents=True, exist_ok=True)
stage = Path(tempfile.mkdtemp(prefix='caddy-verification-', dir=base))
root = stage / 'resources'
(root / 'audio').mkdir(parents=True)
output = io.BytesIO()
with wave.open(output, 'wb') as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(8000)
    wav.writeframes(b'\0\0' * 1600)
audio = output.getvalue()
digest = hashlib.sha256(audio).hexdigest()
resource = 'audio/' + digest + '.wav'
(root / resource).write_bytes(audio)
snippet = (REPO / 'deploy/shared-media-test.caddy').read_text().replace('/var/lib/quizforge-shared-media-test', str(root))
(stage / 'snippet.caddy').write_text(snippet)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
config = stage / 'Caddyfile'
config.write_text('{\nadmin off\nauto_https off\n}\nhttp://127.0.0.1:' + str(port) + ' {\nimport ' + str(stage / 'snippet.caddy') + '\nhandle {\nrespond "unrelated" 200\n}\n}\n')
subprocess.run(['/usr/bin/caddy', 'validate', '--adapter', 'caddyfile', '--config', str(config)], check=True, capture_output=True)
log = (stage / 'caddy.log').open('wb')
server = subprocess.Popen(['/usr/bin/caddy', 'run', '--adapter', 'caddyfile', '--config', str(config)], stdout=log, stderr=log)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
origin = 'http://127.0.0.1:' + str(port)


def request(suffix='/shared-media/' + resource, method='GET', headers=None):
    req = urllib.request.Request(origin + suffix, method=method, headers=headers or {})
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


checks = []
try:
    for attempt in range(50):
        try:
            status, headers, body = request()
            break
        except OSError:
            if server.poll() is not None or attempt == 49:
                raise
            time.sleep(0.05)
    assert status == 200 and body == audio
    assert headers['Access-Control-Allow-Origin'] == '*' and 'immutable' in headers['Cache-Control']
    assert headers['Content-Type'] in ['audio/wav', 'audio/x-wav'] and headers['X-Content-Type-Options'] == 'nosniff', dict(headers)
    checks.append('GET exact audio, CORS, MIME, immutable')
    etag = headers['ETag']
    status, headers, body = request(method='HEAD')
    assert status == 200 and not body and int(headers['Content-Length']) == len(audio)
    checks.append('HEAD')
    status, headers, body = request(headers={'Range': 'bytes=0-15'})
    assert status == 206 and body == audio[:16] and headers['Content-Range'] == 'bytes 0-15/' + str(len(audio))
    checks.append('Range 206')
    status, headers, body = request(headers={'If-None-Match': etag})
    assert status == 304 and not body and 'immutable' in headers['Cache-Control']
    checks.append('ETag 304')
    status, headers, body = request(method='OPTIONS', headers={'Origin': 'http://localhost:8787', 'Access-Control-Request-Method': 'GET'})
    assert status == 204 and headers['Access-Control-Allow-Origin'] == '*'
    checks.append('OPTIONS')
    for method in ['POST', 'PUT', 'DELETE']:
        assert request(method=method)[0] == 405
    checks.append('writes rejected')
    assert request('/shared-media')[0] == 404
    for suffix in ['', 'audio/', '.incoming/', 'audio/private.json', 'audio/' + '0' * 64 + '.mp3']:
        status, headers, body = request('/shared-media/' + suffix)
        assert status == 404, (suffix, status)
        assert 'immutable' not in headers.get('Cache-Control', '')
    checks.append('directory, hidden, arbitrary and missing resources rejected without immutable cache')
    status, headers, body = request(headers={'Range': 'bytes=999999-'})
    assert status == 416 and 'immutable' not in headers.get('Cache-Control', '')
    checks.append('416')
    for conditional in [{'If-Match': '"different"'}, {'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT'}]:
        status, headers, body = request(headers=conditional)
        assert status == 412 and 'immutable' not in headers.get('Cache-Control', ''), (status, dict(headers))
    checks.append('412 precondition errors not cached as immutable')
    assert request('/unrelated')[2] == b'unrelated'
    checks.append('unrelated route preserved')
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _: request(), range(30)))
    assert all(status == 200 and body == audio for status, headers, body in results)
    checks.append('30 synthetic concurrent reads return correct bytes (not capacity certification)')
    result = {'checks': checks, 'passed': len(checks), 'audioSha256': digest, 'bytes': len(audio)}
    (stage / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
finally:
    server.terminate()
    server.wait(timeout=10)
    log.close()
