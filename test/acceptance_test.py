import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

LIB = Path(__file__).parents[1] / "lib"
sys.path.insert(0, str(LIB))
spec = importlib.util.spec_from_file_location("acceptance", LIB / "acceptance.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

REPOSITORY = "owner/repo"
WORKFLOW = ".github/workflows/ci.yml"
NOW = 1_800_000_000


def git(cwd, *args):
    # A throwaway fixture repository: no signing, a fixed identity.
    return subprocess.check_output(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.com",
                                    "-c", "commit.gpgsign=false", *args], cwd=cwd, text=True).strip()


class Fixture:
    """A repository whose HEAD merges a branch into main, as a merge button would."""

    def __init__(self, root):
        self.root = root
        git(root, "init", "-q", "-b", "main")
        (root / "a.txt").write_text("base\n")
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", "base")
        self.base = git(root, "rev-parse", "HEAD")
        git(root, "checkout", "-q", "-b", "feature")
        (root / "b.txt").write_text("feature\n")
        git(root, "add", ".")
        git(root, "commit", "-q", "-m", "feature")
        self.head = git(root, "rev-parse", "HEAD")
        git(root, "checkout", "-q", "main")
        git(root, "merge", "-q", "--no-ff", "-m", "merge", "feature")
        self.merge = git(root, "rev-parse", "HEAD")
        self.tree = git(root, "rev-parse", "HEAD^{tree}")


class FakeAPI:
    """Pull request runs for the pull request lookup, trunk runs for the green-parent one."""

    def __init__(self, runs, trunk):
        self.runs = runs
        self.trunk = trunk
        self.calls = []

    def get(self, path, **query):
        self.calls.append((path, query))
        return {"workflow_runs": self.runs if query.get("event") == "pull_request" else self.trunk}


def iso(timestamp):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.fixture = Fixture(self.repo)
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        self.inputs = {"INPUT_VARIABLES": json.dumps({"MACOS_CI": "off"}), "INPUT_WORKFLOW": "", "INPUT_NAME": "",
                       "INPUT_RESULTS": json.dumps({"lint": {"result": "success"}, "test": {"result": "success"}})}
        patcher = patch.dict(os.environ, self.inputs)
        patcher.start()
        self.addCleanup(patcher.stop)

    def env(self, event_name, payload, **extra):
        path = self.root / "event.json"
        path.write_text(json.dumps(payload))
        return {"GITHUB_EVENT_NAME": event_name, "GITHUB_EVENT_PATH": str(path), "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{WORKFLOW}@refs/heads/main", "GITHUB_SHA": self.fixture.merge,
                "GITHUB_RUN_ID": "41", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_REF": "refs/heads/main",
                "RUNNER_TEMP": str(self.root), **extra}

    def pull_env(self, head_repo=REPOSITORY, head_sha=None):
        payload = {"pull_request": {"head": {"repo": {"full_name": head_repo}, "sha": head_sha or self.fixture.head},
                                    "base": {"repo": {"full_name": REPOSITORY}}}}
        return self.env("pull_request", payload, GITHUB_REF="refs/pull/7/merge")

    def push_env(self, before=None, **extra):
        payload = {"before": before or self.fixture.base, "repository": {"default_branch": "main"}}
        return self.env("push", payload, GITHUB_RUN_ID="42", **extra)

    def receipt(self):
        return acceptance.build_receipt(self.pull_env())

    def run_record(self, **fields):
        run = {"id": 41, "run_attempt": 1, "head_sha": self.fixture.head, "event": "pull_request",
               "status": "completed", "conclusion": "success", "updated_at": iso(NOW - 600),
               "html_url": "https://github.com/owner/repo/actions/runs/41",
               "repository": {"full_name": REPOSITORY}, "head_repository": {"full_name": REPOSITORY}}
        run.update(fields)
        return run

    def trunk_run(self, **fields):
        run = {"id": 30, "head_sha": self.fixture.base, "head_branch": "main", "event": "push", "status": "completed",
               "conclusion": "success", "repository": {"full_name": REPOSITORY}}
        run.update(fields)
        return run

    def verify(self, env=None, runs=None, receipt=None, trunk=None):
        receipt = self.receipt() if receipt is None else receipt
        api = FakeAPI([self.run_record()] if runs is None else runs, [self.trunk_run()] if trunk is None else trunk)
        self.verdict = acceptance.verify(env or self.push_env(), api=api,
                                         receipts=lambda run, name: receipt if receipt != "missing" else None,
                                         now=lambda: NOW)
        return (self.verdict.reused, self.verdict.reason), api

    def test_receipt_records_the_pull_request_merge_tree(self):
        receipt = self.receipt()
        self.assertEqual(receipt["source"], {"sha": self.fixture.merge, "parents": [self.fixture.base, self.fixture.head],
                                             "tree": self.fixture.tree})
        self.assertEqual((receipt["workflow"], receipt["run_id"], receipt["passed"], receipt["skipped"]),
                         (WORKFLOW, 41, ["lint", "test"], []))

    def test_receipt_records_jobs_the_scope_skipped_as_not_passed(self):
        results = {"scope": {"result": "success"}, "lint": {"result": "success"}, "image": {"result": "skipped"}}
        with patch.dict(os.environ, {"INPUT_RESULTS": json.dumps(results)}):
            receipt = self.receipt()
        self.assertEqual((receipt["passed"], receipt["skipped"]), (["lint", "scope"], ["image"]))

    def test_record_refuses_unproven_validation(self):
        cases = {
            "push event": self.push_env(),
            "fork pull request": self.pull_env(head_repo="someone/repo"),
            "checkout of another head": self.pull_env(head_sha="0" * 40),
        }
        for name, env in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                acceptance.build_receipt(env)
        for results in ({"lint": {"result": "success"}, "test": {"result": "failure"}},
                        {"lint": {"result": "success"}, "test": {"result": "cancelled"}},
                        {"lint": "success"}, {}):
            with self.subTest(results=results), patch.dict(os.environ, {"INPUT_RESULTS": json.dumps(results)}), \
                    self.assertRaises(ValueError):
                acceptance.build_receipt(self.pull_env())

    def test_record_uploads_one_receipt_file(self):
        uploaded = {}

        def upload(store, name, patterns, retention, missing):
            uploaded.update(name=name, body=json.loads(Path(patterns).read_text()), retention=retention, missing=missing)

        with patch.object(acceptance.artifact, "upload", upload):
            acceptance.record(self.pull_env(), store=object())
        self.assertEqual(uploaded["name"], "acceptance")
        self.assertEqual(uploaded["body"]["source"]["tree"], self.fixture.tree)
        self.assertEqual((uploaded["retention"], uploaded["missing"]), (7, "error"))

    def test_matching_receipt_reuses_validation(self):
        (reused, reason), api = self.verify()
        self.assertTrue(reused, reason)
        self.assertIn(self.fixture.tree, reason)
        self.assertTrue(self.verdict.green_parent)
        self.assertEqual(api.calls, [
            ("actions/workflows/ci.yml/runs",
             {"head_sha": self.fixture.base, "branch": "main", "status": "success", "per_page": 100}),
            ("actions/workflows/ci.yml/runs",
             {"head_sha": self.fixture.head, "event": "pull_request", "per_page": 100})])

    def test_called_workflow_names_its_own_file(self):
        with patch.dict(os.environ, {"INPUT_WORKFLOW": "ci.yml"}):
            receipt = self.receipt()
            caller = f"{REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
            (reused, reason), api = self.verify(env=self.push_env(GITHUB_WORKFLOW_REF=caller), receipt=receipt)
        self.assertTrue(reused, reason)
        self.assertEqual({call[0] for call in api.calls}, {"actions/workflows/ci.yml/runs"})

    def test_anything_short_of_a_matching_receipt_runs_every_check(self):
        receipt = self.receipt()
        cases = {
            "pull request event": {"env": self.pull_env()},
            "push to another branch": {"env": self.push_env(GITHUB_REF="refs/heads/release")},
            "rerun": {"env": self.push_env(GITHUB_RUN_ATTEMPT="2")},
            "previous head moved": {"env": self.push_env(before="1" * 40)},
            "no pull request run": {"runs": []},
            "fork run": {"runs": [self.run_record(head_repository={"full_name": "someone/repo"})]},
            "latest run failed": {"runs": [self.run_record(),
                                           self.run_record(id=43, conclusion="failure", updated_at=iso(NOW - 60))]},
            "run in progress": {"runs": [self.run_record(status="in_progress", conclusion=None)]},
            "stale run": {"runs": [self.run_record(updated_at=iso(NOW - 7 * 3600))]},
            "no receipt": {"receipt": "missing"},
            "other tree": {"receipt": {**receipt, "source": {**receipt["source"], "tree": "2" * 40}}},
            "other head": {"receipt": {**receipt, "source": {**receipt["source"], "parents": [self.fixture.base, "3" * 40]}}},
            "other variables": {"receipt": {**receipt, "variables": "4" * 64}},
            "other workflow": {"receipt": {**receipt, "workflow": ".github/workflows/other.yml"}},
            "other run attempt": {"receipt": {**receipt, "run_attempt": 2}},
            "other run": {"receipt": {**receipt, "run_id": 40}},
        }
        for name, case in cases.items():
            with self.subTest(name):
                (reused, reason), _ = self.verify(**case)
                self.assertFalse(reused, reason)

    def test_reuse_needs_every_required_job_to_have_passed(self):
        results = {"scope": {"result": "success"}, "lint": {"result": "success"}, "image": {"result": "skipped"}}
        with patch.dict(os.environ, {"INPUT_RESULTS": json.dumps(results)}):
            receipt = self.receipt()
        cases = {
            "": (False, "image"),
            '["lint"]': (True, ""),
            "lint\nscope\n": (True, ""),
            "[]": (True, ""),
            '["lint", "image"]': (False, "image"),
            '["test"]': (False, "test"),
        }
        for required, (expected, missing) in cases.items():
            with self.subTest(required=required), patch.dict(os.environ, {"INPUT_REQUIRED": required}):
                (reused, reason), _ = self.verify(receipt=receipt)
                self.assertEqual(reused, expected, reason)
                self.assertIn(missing, reason)
        legacy = {key: value for key, value in receipt.items() if key not in ("passed", "skipped")}
        with patch.dict(os.environ, {"INPUT_REQUIRED": '["lint"]'}):
            (reused, reason), _ = self.verify(receipt=legacy)
        self.assertFalse(reused, reason)

    def test_invalid_required_fails_the_step(self):
        for required in ('{"lint": 1}', '["lint", 2]', '[""]', "[not json"):
            with self.subTest(required=required), patch.dict(os.environ, {"INPUT_REQUIRED": required}), \
                    self.assertRaises(ValueError):
                self.verify()

    def test_a_red_parent_never_reuses(self):
        # Push run R1 on the parent failed a job the pull request's scope
        # skipped; reusing the receipt would make the merge the next green base.
        cases = {
            "no trunk run": [],
            "failed trunk run": [self.trunk_run(conclusion="failure")],
            "trunk run of another commit": [self.trunk_run(head_sha="5" * 40)],
            "pull request run": [self.trunk_run(event="pull_request")],
            "run on another branch": [self.trunk_run(head_branch="release")],
            "run in a fork": [self.trunk_run(repository={"full_name": "someone/repo"})],
            "this run": [self.trunk_run(id=42)],
        }
        for name, trunk in cases.items():
            with self.subTest(name):
                (reused, reason), api = self.verify(trunk=trunk)
                self.assertFalse(reused, reason)
                self.assertIs(self.verdict.green_parent, False)
                self.assertIn("has no green run of ci.yml", reason)
                self.assertEqual(len(api.calls), 1, "no pull request lookup on a red parent")
        for event in ("schedule", "workflow_dispatch"):
            with self.subTest(event=event):
                (reused, reason), _ = self.verify(trunk=[self.trunk_run(event=event)])
                self.assertTrue(reused, reason)

    def test_single_parent_push_runs_every_check(self):
        receipt = self.receipt()
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "direct")
        sha = git(self.repo, "rev-parse", "HEAD")
        (reused, reason), _ = self.verify(env=self.push_env(GITHUB_SHA=sha, before=self.fixture.merge), receipt=receipt)
        self.assertFalse(reused)
        self.assertIn("single merge commit", reason)

    def test_lookup_errors_run_every_check(self):
        class Broken:
            def get(self, path, **query):
                raise OSError("connection refused")

        reused, reason, green_parent = acceptance.verify(self.push_env(), api=Broken(), receipts=lambda run, name: None,
                                                         now=lambda: NOW)
        self.assertFalse(reused)
        self.assertIsNone(green_parent)
        self.assertIn("connection refused", reason)

    def test_receipt_archive_holds_exactly_the_receipt(self):
        class Store:
            def __init__(self, files):
                self.files = files

            def manifests(self, run_id, attempt):
                return [{"name": "acceptance", "key": "k", "size": 1, "sha256": "x"}]

        def fetch(files):
            def write(store, item, archive, max_bytes):
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as bundle:
                    for name, content in files.items():
                        bundle.writestr(name, content)
                archive.write_bytes(buffer.getvalue())
            return write

        run = self.run_record()
        with patch.object(acceptance.artifact, "fetch", fetch({"acceptance.json": '{"version": 1}'})):
            self.assertEqual(acceptance.fetch_receipt(run, "acceptance", Store({})), {"version": 1})
            self.assertIsNone(acceptance.fetch_receipt(run, "other", Store({})))
        with patch.object(acceptance.artifact, "fetch", fetch({"acceptance.json": "{}", "extra": "x"})), \
                self.assertRaises(ValueError):
            acceptance.fetch_receipt(run, "acceptance", Store({}))


if __name__ == "__main__":
    unittest.main()
