"""Explicit server-only account acceptance on the designated isolated test DB.

Uses one temporary synthetic account, never prints its password/token, never
sends a real verification message and removes its rows even on failure.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import urllib.error
import urllib.request
import uuid

ORIGIN = "https://quizforge-test.treenewbee.cloud"
DATA = Path("/var/lib/quizforge-hub-java-test")


def call(path, body=None, cookie=None, origin=ORIGIN):
    headers = {"Accept": "application/json", "User-Agent": "QuizForge-Java-Account-Test/1"}
    if origin:
        headers["Origin"] = origin
    if cookie:
        headers["Cookie"] = cookie
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(ORIGIN + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.headers.get("X-QuizForge-Environment") == "java-test", "Unexpected environment"
        return response.status, json.load(response), response.headers


def verify():
    assert DATA.resolve() == DATA and not DATA.is_symlink(), "Unexpected data location"
    checks = []
    assert call("/api/health")[1].get("phase") == "hub-feature-parity", "Wrong runtime phase"
    config = call("/api/config")[1]
    assert isinstance(config["officialAi"]["enabled"], bool), "AI capability must be explicit"
    checks.append("Native account runtime and configured AI capability are explicit")
    with closing(sqlite3.connect(DATA / "hub.sqlite", timeout=10)) as db:
        before = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    checks.append("Existing test data remains readable after additive schema migration")
    identity = str(uuid.uuid4())
    email = "java-acceptance-" + identity + "@example.test"
    password = secrets.token_urlsafe(36)
    salt = secrets.token_hex(16)
    encoded = salt + ":" + hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024).hex()
    policy = config["authPolicy"]
    if policy["loginCodeRequired"] or policy["loginCaptchaRequired"]:
        raise RuntimeError("Operator enabled extra login verification; do not weaken it for acceptance")
    try:
        with closing(sqlite3.connect(DATA / "hub.sqlite", timeout=10)) as db:
            db.execute("INSERT INTO users(id,email,name,password,admin,created) VALUES(?,?,?, ?,0,'2026-10-25T00:00:00.000Z')", (identity, email, "Java临时验收账号", encoded))
            db.commit()
        status, _, headers = call("/api/auth/login", {"email": email, "password": password}, origin="https://untrusted.example")
        assert status == 403 and headers.get("Set-Cookie") is None, "Cross-origin login was accepted"
        checks.append("Cross-origin login is rejected without creating a browser session")
        status, result, headers = call("/api/auth/login", {"email": email, "password": password})
        assert status == 200 and result["user"]["id"] == identity, "Synthetic login failed"
        cookie = headers.get("Set-Cookie", "")
        assert all(part in cookie for part in ("qfh_java_test=", "HttpOnly", "SameSite=Lax", "; Secure", "Max-Age=2592000")), "Cookie protection missing"
        cookie = cookie.split(";", 1)[0]
        token = cookie.split("=", 1)[1]
        with closing(sqlite3.connect(DATA / "hub.sqlite", timeout=10)) as db:
            assert db.execute("SELECT token FROM sessions WHERE user_id=?", (identity,)).fetchone()[0] == hashlib.sha256(token.encode()).hexdigest(), "Session is not hash-only"
        checks.append("Linux Java login accepts a legacy-format hash and sets a secure hash-only session")
        status, me, _ = call("/api/me", cookie=cookie)
        assert status == 200 and me["user"]["id"] == identity and "password" not in me["user"], "Profile identity mismatch"
        checks.append("Authenticated profile resolves to the same stable user without password data")
        status, result, headers = call("/api/auth/logout", {}, cookie=cookie)
        assert status == 200 and result["ok"] and "Max-Age=0" in headers.get("Set-Cookie", ""), "Logout failed"
        assert call("/api/me", cookie=cookie)[1]["user"] is None, "Old session remained valid"
        checks.append("Logout revokes the session and clears the browser cookie")
        # No real provider request: only exercise the deliberately disabled channel.
        if not config["verificationMethods"]["email"]:
            assert call("/api/auth/email-code", {"email": email})[0] == 503, "Disabled mail channel did not fail closed"
            checks.append("Unconfigured email verification fails closed without paid delivery")
        for path in ("/hub.sqlite", "/account-schema.sql", "/java-hub/src/main/resources/account-schema.sql"):
            assert call(path)[0] == 404, "Private source or data was exposed"
        checks.append("Account storage and schema files are not exposed over HTTP")
    finally:
        with closing(sqlite3.connect(DATA / "hub.sqlite", timeout=10)) as db:
            for table in ("sessions", "unverified_contacts", "user_phones", "ai_points_ledger", "ai_points", "connect_codes", "connect_devices"):
                db.execute("DELETE FROM " + table + " WHERE user_id=?", (identity,))
            db.execute("DELETE FROM users WHERE id=?", (identity,))
            db.commit()
            assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == before, "Temporary account cleanup changed original accounts"
    checks.append("Temporary synthetic credentials and account rows were removed")
    return {"origin": ORIGIN, "checksPassed": len(checks), "checks": checks, "temporaryAccountRemoved": True, "realProviderDelivery": False, "browserAcceptance": False}


if __name__ == "__main__":
    print(json.dumps(verify(), ensure_ascii=False, indent=2))
