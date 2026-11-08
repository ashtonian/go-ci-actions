import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
            def request(self, *_, target):
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

    def test_no_plaintext_external_endpoint(self):
        with self.assertRaises(ValueError):
            artifact.Store("http://artifacts.example.test")


if __name__ == "__main__":
    unittest.main()
