"""Create a separate Java preview from published Hub data, without accounts/secrets.

This is not a complete migration backup. Source SQLite is opened read-only;
only approved packs, their public comments/author names and referenced files
are copied. A concurrent removal fails the copy instead of certifying it.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3


def checked_copy(source, destination, size, digest=None):
    if source.is_symlink() or not source.is_file() or source.stat().st_size != size:
        raise ValueError("Public file is missing, linked or changed")
    with source.open("rb") as reader, destination.open("xb") as writer:
        actual = hashlib.sha256()
        total = 0
        while block := reader.read(1024 * 1024):
            actual.update(block)
            writer.write(block)
            total += len(block)
    if total != size or (digest and actual.hexdigest() != digest):
        raise ValueError("Public file checksum changed")
    return actual.hexdigest()


def seed(source, target, schema):
    os.umask(0o077)
    source, target = Path(source).resolve(strict=True), Path(target).resolve()
    if target == source or source in target.parents or target in source.parents:
        raise ValueError("Source and preview must be separate directories")
    if target.exists():
        raise ValueError("Preview target already exists; never overwrite data")
    if (source / "hub.sqlite").is_symlink():
        raise ValueError("Linked database is not allowed")
    for folder in ("files", "downloads"):
        if (source / folder).is_symlink():
            raise ValueError("Linked source directory is not allowed")
    with closing(sqlite3.connect((source / "hub.sqlite").as_uri() + "?mode=ro", uri=True)) as original:
        original.row_factory = sqlite3.Row
        original.execute("PRAGMA query_only=ON")
        original.execute("BEGIN")
        packs = original.execute("SELECT id,user_id,title,summary,description,category,tags,version,downloads,created,updated,status,revision FROM packs WHERE status='approved' ORDER BY id").fetchall()
        target.mkdir(mode=0o700)
        (target / "files").mkdir(mode=0o700)
        (target / "downloads").mkdir(mode=0o700)
        copied, authors = {}, set()
        with closing(sqlite3.connect(target / "hub.sqlite")) as output:
            output.executescript(Path(schema).read_text(encoding="utf-8-sig"))
            output.execute("PRAGMA foreign_keys=ON")

            def author(identity):
                if identity in authors:
                    return
                user = original.execute("SELECT id,name FROM users WHERE id=?", (identity,)).fetchone()
                if user is None:
                    raise ValueError("Published author is missing")
                output.execute("INSERT INTO users(id,email,name,password,admin,created) VALUES(?,NULL,?,'!public-preview-only',0,'1970-01-01T00:00:00.000Z')", (user["id"], user["name"]))
                authors.add(identity)

            for pack in packs:
                author(pack["user_id"])
                columns = list(pack.keys())
                output.execute("INSERT INTO packs(" + ",".join(columns) + ") VALUES(" + ",".join("?" for _ in columns) + ")", tuple(pack))
                for item in original.execute("SELECT id,pack_id,kind,name,mime,size,sha256 FROM files WHERE pack_id=? AND kind IN ('archive','image')", (pack["id"],)):
                    if not re.fullmatch(r"[a-f0-9-]{36}", item["id"]):
                        raise ValueError("Invalid public attachment ID")
                    copied["files/" + item["id"]] = checked_copy(source / "files" / item["id"], target / "files" / item["id"], item["size"], item["sha256"])
                    output.execute("INSERT INTO files(id,pack_id,kind,name,mime,size,sha256) VALUES(?,?,?,?,?,?,?)", tuple(item))
                for comment in original.execute("SELECT id,pack_id,user_id,body,created FROM comments WHERE pack_id=?", (pack["id"],)):
                    author(comment["user_id"])
                    output.execute("INSERT INTO comments(id,pack_id,user_id,body,created) VALUES(?,?,?,?,?)", tuple(comment))
            manifest_file = source / "downloads" / "manifest.json"
            installers = []
            if manifest_file.exists():
                if manifest_file.is_symlink() or manifest_file.stat().st_size > 65536:
                    raise ValueError("Invalid public software manifest")
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                for item in manifest.get("items", []):
                    name, size = item.get("file"), item.get("bytes")
                    if item.get("platform") not in ("windows", "android") or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", name) or type(size) is not int or size < 0:
                        raise ValueError("Invalid public installer entry")
                    copied["downloads/" + name] = checked_copy(source / "downloads" / name, target / "downloads" / name, size, item.get("sha256"))
                    installers.append(item)
                (target / "downloads" / "manifest.json").write_text(json.dumps({"items": installers}, ensure_ascii=False) + "\n", encoding="utf-8")
            output.commit()
            if output.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or output.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("Preview database integrity failed")
            if output.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] or output.execute("SELECT COUNT(*) FROM users WHERE email IS NOT NULL OR admin!=0 OR password!='!public-preview-only'").fetchone()[0]:
                raise ValueError("Preview contains private account data")
        record = {"schemaVersion": 1, "purpose": "public-only-java-test-preview", "complete": True, "packs": len(packs), "publicAuthorNames": len(authors), "copiedFiles": copied, "accountCredentialsCopied": False, "sessionsCopied": False, "adminContactCopied": False}
        (target / "public-preview.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        # This is a fresh preview DB, not a stopped-service full migration snapshot.
        (target / "java-hub-local.json").write_text(json.dumps({"schemaVersion": 1, "purpose": "public-only-java-test-preview"}) + "\n", encoding="utf-8")
        return {"packs": len(packs), "publicAuthorNames": len(authors), "copiedFiles": len(copied), "privateAccountsCopied": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("new_target")
    parser.add_argument("--schema", required=True)
    options = parser.parse_args()
    print(json.dumps(seed(options.source, options.new_target, options.schema)))
