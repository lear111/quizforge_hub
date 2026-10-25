"""HTTP acceptance for the isolated Java TEST domain; never signs in or writes content."""
import hashlib
from html.parser import HTMLParser
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit


def verify(origin):
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or parsed.hostname != "quizforge-test.treenewbee.cloud" or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("Only the designated HTTPS test domain is supported")
    origin = origin.rstrip("/")
    checks = []

    def request(path, method="GET", expected=200):
        req = urllib.request.Request(origin + path, method=method, headers={"User-Agent": "QuizForge-Java-Test-Acceptance/1", "Accept": "*/*"})
        try:
            response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            if response.status != expected:
                raise AssertionError(f"{method} {path}: {response.status}, expected {expected}")
            if response.headers.get("X-QuizForge-Environment") != "java-test":
                raise AssertionError("Request did not reach the Java test route")
            return body, response.headers

    def api(path, expected=200):
        return json.loads(request(path, expected=expected)[0])

    assert api("/api/health")["runtime"] == "java"
    checks.append("HTTPS health reaches the Java service")
    document, headers = request("/")
    assert "default-src 'self'" in headers["Content-Security-Policy"]

    class Assets(HTMLParser):
        paths = set()

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            asset = attrs.get("src") if tag == "script" else attrs.get("href") if tag == "link" else None
            if asset:
                assert asset.startswith("/") and not asset.startswith("//"), "Unexpected external page asset"
                self.paths.add(asset)

    assets = Assets()
    assets.feed(document.decode("utf-8"))
    assets.paths.update(("/catalog-view.mjs", "/account-ui.mjs", "/detail-ui.mjs", "/admin-contact.css", "/quizforge-icon.png"))
    for path in sorted(assets.paths):
        data, asset_headers = request(path)
        assert data, f"Empty resource: {path}"
        if path.endswith((".js", ".mjs")):
            assert "javascript" in asset_headers["Content-Type"], f"Incorrect module MIME: {path}"
    checks.append(f"Home page, CSP and {len(assets.paths)} static resources are available")
    assert api("/api/me") == {"user": None}
    assert api("/api/packs?mine=1", expected=401).get("error")
    capabilities = api("/api/java/capabilities")
    assert capabilities["phase"] == "hub-feature-parity"
    assert {"publishing", "review", "admin-management", "ai-gateway", "practice-internal-api", "local-import"} <= set(capabilities["native"])
    assert capabilities["localImportEnabled"] is False
    checks.append("Anonymous identity, private listing and native capabilities are explicit")
    listing = api("/api/packs")
    assert listing["count"] > 0 and listing["packs"]
    assert api("/api/packs?q=quizforge-java-no-match-20261025")["count"] == 0
    assert api("/api/packs?page=99999")["packs"] == []
    assert api("/api/packs?sort=popular")["packs"]
    checks.append("Public catalogue, search, sort and pagination respond")
    pack = listing["packs"][0]
    detail = api("/api/packs/" + pack["id"])
    assert detail["pack"]["id"] == pack["id"]
    assert detail["pack"]["status"] == "approved"
    assert api("/api/packs/" + pack["id"] + "/download-status")["ok"]
    archive, archive_headers = request("/api/packs/" + pack["id"] + "/download")
    assert len(archive) == pack["archive"]["size"]
    assert hashlib.sha256(archive).hexdigest() == pack["archive"]["sha256"]
    assert "filename*=UTF-8''" in archive_headers["Content-Disposition"]
    checks.append("Published archive downloads completely with the expected SHA256 and filename")
    for image in pack["screenshots"]:
        data, _ = request("/media/" + image["id"])
        assert hashlib.sha256(data).hexdigest() == image["sha256"]
    checks.append("Published screenshots have matching SHA256")
    installers = api("/api/downloads")["items"]
    assert installers
    for item in installers:
        data, installer_headers = request("/download/files/" + quote(item["file"]), "HEAD")
        assert not data and int(installer_headers["Content-Length"]) == item["bytes"]
    checks.append("Software manifest and installer HEAD match the copied files")
    # The test site can now use a complete legacy test-data copy. Validate the
    # contract without printing the copied public contact or requiring it empty.
    contact = api("/api/admin-contact")
    assert isinstance(contact.get("content"), str) and len(contact["content"].encode("utf-16-le")) // 2 <= 4000
    assert type(contact.get("revision")) is int and 0 <= contact["revision"] <= 9007199254740991
    checks.append("Contact follows the public text contract without logging its content")
    for path in ("/.env", "/hub.sqlite", "/java-hub-local.json", "/java-migration-snapshot.json", "/public-preview.json", "/data-java/hub.sqlite", "/api/unknown-java-test-route"):
        request(path, expected=404)
    checks.append("Private data paths and unknown APIs return 404")
    return {"origin": origin, "checksPassed": len(checks), "checks": checks, "publicPacks": listing["count"], "browserAcceptance": False, "productionDataMigration": False}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1]), ensure_ascii=False, indent=2))
