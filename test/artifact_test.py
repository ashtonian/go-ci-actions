import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

spec = importlib.util.spec_from_file_location("artifact", Path(__file__).parents[1] / "lib/artifact.py")
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


class ArtifactTests(unittest.TestCase):
    def test_glob_root_hidden_and_exclusions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "logs/sub").mkdir(parents=True)
            for name in ["logs/a.json", "logs/sub/b.json", "logs/.secret", "logs/excluded.json"]:
                (root / name).write_text(name)
            selected_root, files = artifact.select_files(f"{root}/logs/**/*.json\n!{root}/logs/excluded.json")
            self.assertEqual(selected_root, root / "logs")
            self.assertEqual([str(p.relative_to(selected_root)) for p in files], ["a.json", "sub/b.json"])
            _, files = artifact.select_files(str(root / "logs"))
            self.assertNotIn(root / "logs/.secret", files)
            _, files = artifact.select_files(str(root / "logs"), True)
            self.assertIn(root / "logs/.secret", files)

    def test_multiple_paths_share_common_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ["one/a", "two/b"]:
                file = root / name
                file.parent.mkdir(parents=True)
                file.write_text(name)
            base, files = artifact.select_files(f"{root}/one\n{root}/two")
            self.assertEqual(base, root)
            self.assertEqual([p.relative_to(base).as_posix() for p in files], ["one/a", "two/b"])

    def test_symlink_escape_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inside").mkdir()
            (root / "secret").write_text("private")
            (root / "inside/link").symlink_to(root)
            with self.assertRaises(ValueError):
                artifact.select_files(str(root / "inside/link/secret"))

    def test_archive_traversal_and_existing_symlink_refused(self):
        for name in ["../escape", "/absolute", "C:/drive", "a\\..\\escape"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with zipfile.ZipFile(root / "a.zip", "w") as archive:
                    archive.writestr(name, "bad")
                with self.assertRaises(ValueError):
                    artifact.extract(root / "a.zip", root / "dest")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dest").mkdir()
            (root / "dest/link").symlink_to(root)
            with zipfile.ZipFile(root / "a.zip", "w") as archive:
                archive.writestr("link/escape", "bad")
            with self.assertRaises(ValueError):
                artifact.extract(root / "a.zip", root / "dest")

    def test_manifest_cannot_redirect_to_another_run(self):
        item = dict(version=1, repository_id="2", run_id="3", run_attempt="1", name="receipt", retention_days=7,
                    sha256="0" * 64, size=1, expires_at=9999999999)
        item["key"] = artifact.data_key(item)
        artifact.validate_manifest(item, "2", "3")
        item["key"] = item["key"].replace("/2/3/", "/2/4/")
        with self.assertRaises(ValueError):
            artifact.validate_manifest(item, "2", "3")

    def test_corrupt_archive_is_not_extracted(self):
        item = dict(version=1, repository_id="2", run_id="3", run_attempt="1", name="receipt", retention_days=7,
                    sha256="0" * 64, size=7, expires_at=9999999999)
        item["key"] = artifact.data_key(item)
        class Store:
            def manifests(self, *_):
                return [item]
            def request(self, *_, target, **kwargs):
                target.write_bytes(b"corrupt")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                artifact.download(Store(), Path(directory) / "dest", name="receipt")
            self.assertFalse((Path(directory) / "dest").exists())

    def test_latest_attempt_preserves_earlier_successful_jobs(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY_ID": "2", "GITHUB_RUN_ID": "3", "GITHUB_RUN_ATTEMPT": "2"}):
            store = artifact.Store("https://artifacts.example.test")
        documents = {}
        for name, attempt in [("build", "1"), ("test", "1"), ("test", "2")]:
            item = dict(version=1, repository_id="2", run_id="3", run_attempt=attempt, name=name, retention_days=7,
                        sha256="0" * 64, size=1, expires_at=9999999999)
            item["key"] = artifact.data_key(item)
            documents[artifact.manifest_key(item)] = json.dumps(item).encode()
        listing = ('<ListBucketResult><IsTruncated>false</IsTruncated>' + ''.join(f'<Contents><Key>{key}</Key></Contents>' for key in documents) + '</ListBucketResult>').encode()
        store.request = lambda method, key="", **kwargs: (documents[key] if key else listing, {})
        self.assertEqual([(i["name"], i["run_attempt"]) for i in store.manifests()], [("build", "1"), ("test", "2")])
        self.assertEqual([(i["name"], i["run_attempt"]) for i in store.manifests(attempt="1")], [("build", "1"), ("test", "1")])

    def test_download_refuses_oversized_manifest_before_transfer(self):
        class Store:
            def manifests(self, *_):
                return [{"name": "receipt", "size": 129}]
            def request(self, *_args, **_kwargs):
                raise AssertionError("oversized artifact must not be transferred")
        with self.assertRaisesRegex(ValueError, "byte limit"):
            artifact.download(Store(), "unused", name="receipt", max_bytes=128)

    def test_no_plaintext_external_endpoint(self):
        with self.assertRaises(ValueError):
            artifact.Store("http://artifacts.example.test")

    def test_transient_failures_are_retried_within_the_budget(self):
        claims = {"repository_id": "1", "run_id": "2", "run_attempt": "3", "aud": artifact.AUDIENCE,
                  "exp": time.time() + 600}
        token = "h." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".s"
        env = {"CI_ARTIFACT_ENDPOINT": "https://artifacts.example.test", "GITHUB_REPOSITORY_ID": "1",
               "GITHUB_RUN_ID": "2", "GITHUB_RUN_ATTEMPT": "3",
               "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.example.test/?api-version=2.0",
               "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "request-token"}
        token_host, gateway_host = "token.example.test", "artifacts.example.test"

        class Response(io.BytesIO):
            headers = {}

        class Opener:
            """Fails the first `failures` requests to `host` with `code`, then answers normally."""
            def __init__(self, host, failures, code, headers):
                self.host, self.failures, self.code, self.headers, self.calls = host, failures, code, headers, []

            def open(self, req, timeout):
                host = req.full_url.split("/")[2]
                self.calls.append(host)
                if host == self.host and self.calls.count(host) <= self.failures:
                    raise urllib.error.HTTPError(req.full_url, self.code, "error", self.headers, None)
                if host == token_host:
                    return Response(json.dumps({"value": token}).encode())
                return Response(b"{}")

        tests = [
            {"name": "transient token error", "host": token_host, "failures": 1, "code": 503, "headers": {},
             "calls": [token_host, token_host, gateway_host], "sleeps": [1], "logged": "GitHub OIDC token request"},
            {"name": "Retry-After is honoured", "host": token_host, "failures": 1, "code": 503,
             "headers": {"Retry-After": "7"}, "calls": [token_host, token_host, gateway_host], "sleeps": [7],
             "logged": "GitHub OIDC token request"},
            {"name": "Retry-After is capped", "host": token_host, "failures": 1, "code": 429,
             "headers": {"Retry-After": "3600"}, "calls": [token_host, token_host, gateway_host], "sleeps": [30],
             "logged": "GitHub OIDC token request"},
            {"name": "transient gateway error", "host": gateway_host, "failures": 2, "code": 502, "headers": {},
             "calls": [token_host, gateway_host, gateway_host, gateway_host], "sleeps": [1, 2],
             "logged": "GET ci-artifacts/metadata/x.json"},
            {"name": "outage longer than the budget", "host": token_host, "failures": 6, "code": 503, "headers": {},
             "calls": [token_host] * 6, "sleeps": [1, 2, 4, 8, 16], "raises": True,
             "logged": "attempt 5 of 6, retrying in 16 s"},
            {"name": "permission error is not retried", "host": token_host, "failures": 1, "code": 403, "headers": {},
             "calls": [token_host], "sleeps": [], "raises": True, "logged": ""},
        ]
        for tt in tests:
            with self.subTest(tt["name"]), patch.dict(os.environ, env), \
                    patch.object(artifact.time, "sleep") as sleep, patch("sys.stderr", io.StringIO()) as stderr:
                store = artifact.Store()
                store.opener = Opener(tt["host"], tt["failures"], tt["code"], tt["headers"])
                if tt.get("raises"):
                    with self.assertRaises(urllib.error.HTTPError):
                        store.request("GET", "metadata/x.json")
                else:
                    self.assertEqual(store.request("GET", "metadata/x.json")[0], b"{}")
                self.assertEqual(store.opener.calls, tt["calls"])
                self.assertEqual([c.args[0] for c in sleep.call_args_list], tt["sleeps"])
                self.assertIn(tt["logged"], stderr.getvalue())

if __name__ == "__main__":
    unittest.main()
