import hashlib
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "java-hub/src/main/resources/schema.sql"
SPEC = importlib.util.spec_from_file_location("public_seed", ROOT / "scripts/seed-java-public-preview.py")
SEED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SEED)


class PublicPreviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "original"
        self.target = Path(self.temp.name) / "preview"
        (self.source / "files").mkdir(parents=True)
        (self.source / "downloads").mkdir()
        self.file_id = "10000000-0000-4000-8000-000000000001"
        data = b"public archive fixture"
        (self.source / "files" / self.file_id).write_bytes(data)
        with closing(sqlite3.connect(self.source / "hub.sqlite")) as db:
            db.executescript(SCHEMA.read_text(encoding="utf-8"))
            db.execute("INSERT INTO users VALUES('public-author','private@example.test','Public author','private-password-fixture',1,'today')")
            db.execute("INSERT INTO users VALUES('private-user','hidden@example.test','Private account','private-password-fixture',0,'today')")
            db.execute("INSERT INTO sessions VALUES('private-session','public-author',9999999999999)")
            for identity, status in (("published", "approved"), ("hidden", "pending")):
                db.execute("INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES(?,'public-author',?,'summary','description','test','[]','1.0','today','today',?)", (identity, identity, status))
            db.execute("INSERT INTO files VALUES(?,'published','archive','example.qbank','application/octet-stream',?,?)", (self.file_id, len(data), hashlib.sha256(data).hexdigest()))
            db.execute("INSERT INTO comments VALUES('comment','published','public-author','Public comment','today')")
            db.execute("UPDATE admin_contact SET content='private contact fixture',revision=5")
            db.commit()
        self.source_hash = hashlib.sha256((self.source / "hub.sqlite").read_bytes()).hexdigest()

    def test_copies_only_published_data_and_no_credentials(self):
        report = SEED.seed(self.source, self.target, SCHEMA)
        self.assertEqual(report["packs"], 1)
        self.assertFalse(report["privateAccountsCopied"])
        with closing(sqlite3.connect(self.target / "hub.sqlite")) as db:
            self.assertEqual(db.execute("SELECT id FROM packs").fetchall(), [("published",)])
            self.assertEqual(db.execute("SELECT name,email,password,admin FROM users").fetchall(), [("Public author", None, "!public-preview-only", 0)])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT content,revision FROM admin_contact").fetchone(), ("", 0))
        self.assertTrue((self.target / "java-hub-local.json").is_file())
        self.assertEqual(self.source_hash, hashlib.sha256((self.source / "hub.sqlite").read_bytes()).hexdigest())

    def test_existing_target_is_never_overwritten(self):
        self.target.mkdir()
        marker = self.target / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "already exists"):
            SEED.seed(self.source, self.target, SCHEMA)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_changed_file_does_not_certify_partial_preview(self):
        (self.source / "files" / self.file_id).write_bytes(b"corrupted public fixture")
        with self.assertRaises(ValueError):
            SEED.seed(self.source, self.target, SCHEMA)
        self.assertFalse((self.target / "java-hub-local.json").exists())
        self.assertFalse((self.target / "public-preview.json").exists())


if __name__ == "__main__":
    unittest.main()
