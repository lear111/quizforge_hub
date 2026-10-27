import concurrent.futures
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('publisher', REPO / 'deploy/publish-shared-audio.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublisherTest(unittest.TestCase):
    def setUp(self):
        base = REPO / '.temp/shared-media-tests'
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='publisher-', dir=base)
        self.root = Path(self.temp.name)
        (self.root / 'audio').mkdir()
        (self.root / '.incoming').mkdir()
        self.bytes = b'ID3synthetic-audio'
        self.sha = hashlib.sha256(self.bytes).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def put(self, data=None, sha=None, size=None):
        return publisher.publish(io.BytesIO(self.bytes if data is None else data), self.root,
                                 self.sha if sha is None else sha, 'mp3', len(self.bytes) if size is None else size)

    def test_publish_reuse_and_content_change(self):
        a, b = self.put(), self.put()
        self.assertEqual(a['status'], 'uploaded')
        self.assertEqual(b['status'], 'reused')
        self.assertEqual((self.root / a['path']).read_bytes(), self.bytes)
        changed = self.bytes + b'new'
        c = self.put(changed, hashlib.sha256(changed).hexdigest(), len(changed))
        self.assertNotEqual(a['url'], c['url'])
        self.assertEqual(list((self.root / '.incoming').iterdir()), [])

    def test_invalid_identity_and_limits(self):
        for sha, size in [('../x', 1), (self.sha, 0), (self.sha, publisher.MAX_BYTES + 1)]:
            with self.assertRaises(ValueError):
                self.put(sha=sha, size=size)
        self.assertEqual(list((self.root / 'audio').iterdir()), [])

    def test_bad_digest_and_header_cleanup(self):
        for data, sha in [(self.bytes, '0' * 64), (b'not audio', hashlib.sha256(b'not audio').hexdigest())]:
            with self.assertRaises(ValueError):
                self.put(data, sha, len(data))
            self.assertEqual(list((self.root / '.incoming').iterdir()), [])
        self.assertEqual(list((self.root / 'audio').iterdir()), [])

    def test_truncated_and_overlong_streams_cleanup(self):
        for data in [self.bytes[:-1], self.bytes + b'extra']:
            with self.assertRaises(ValueError):
                self.put(data)
            self.assertEqual(list((self.root / '.incoming').iterdir()), [])

    def test_existing_corruption_is_not_overwritten(self):
        destination = self.root / 'audio' / (self.sha + '.mp3')
        destination.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.put()
        self.assertEqual(destination.read_bytes(), b'changed')

    def test_concurrent_identical_uploads_publish_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.put(), range(8)))
        self.assertEqual(sum(r['status'] == 'uploaded' for r in results), 1)
        self.assertEqual(len(list((self.root / 'audio').iterdir())), 1)
        self.assertEqual(list((self.root / '.incoming').iterdir()), [])

    @unittest.skipIf(os.name == 'nt', 'Linux deployment verifies symlink rejection')
    def test_symlink_target_rejected(self):
        outside = self.root / 'private'
        outside.write_bytes(self.bytes)
        (self.root / 'audio' / (self.sha + '.mp3')).symlink_to(outside)
        with self.assertRaises(ValueError):
            self.put()
        self.assertEqual(outside.read_bytes(), self.bytes)


if __name__ == '__main__':
    unittest.main()
