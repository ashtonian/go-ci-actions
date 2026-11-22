import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
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
        # A scoped caller: the push requires lint and test, measured from the
        # previous head (the last green run), and both check everything.
        self.inputs.update({"INPUT_BASE": self.fixture.base, "INPUT_REQUIRED": '["lint", "test"]',
                            "INPUT_SELECTIONS": json.dumps({"lint": "all", "test": "all"})})
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
        self.assertTrue(self.verdict.green_base)
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
        everything = json.dumps({"scope": "all", "lint": "all", "image": "all", "test": "all"})
        with patch.dict(os.environ, {"INPUT_RESULTS": json.dumps(results), "INPUT_SELECTIONS": everything}):
            receipt = self.receipt()
        cases = {
            "": (False, "image", None),
            '["lint"]': (True, "", []),
            "lint\nscope\n": (True, "", []),
            "[]": (True, "", []),
            '["lint", "image"]': (False, "runs image", ["image"]),
            '["test"]': (False, "runs test", ["test"]),
        }
        for required, (expected, mentioned, remaining) in cases.items():
            with self.subTest(required=required), patch.dict(os.environ, {"INPUT_REQUIRED": required, "INPUT_SELECTIONS": everything}):
                (reused, reason), _ = self.verify(receipt=receipt)
                self.assertEqual(reused, expected, reason)
                self.assertIn(mentioned, reason)
                self.assertEqual(self.verdict.remaining, remaining)
        legacy = {key: value for key, value in receipt.items() if key not in ("passed", "skipped")}
        with patch.dict(os.environ, {"INPUT_REQUIRED": '["lint"]'}):
            (reused, reason), _ = self.verify(receipt=legacy)
        self.assertFalse(reused, reason)

    def test_verify_outputs_the_jobs_the_push_still_runs(self):
        cases = [
            ('["lint", "image"]', acceptance.Verdict(False, "no receipt"), '["image", "lint"]'),
            ('["lint", "image"]', acceptance.Verdict(False, "partial", True, ["image"]), '["image"]'),
            ('["lint"]', acceptance.Verdict(True, "reused", True, []), "[]"),
            ("", acceptance.Verdict(False, "unscoped"), ""),
        ]
        for required, verdict, remaining in cases:
            with self.subTest(verdict.reason):
                outputs = self.root / ("outputs-" + verdict.reason)
                with patch.dict(os.environ, {"INPUT_MODE": "verify", "INPUT_REQUIRED": required, "GITHUB_OUTPUT": str(outputs)}), \
                        patch.object(acceptance, "verify", lambda env: verdict):
                    acceptance.main()
                lines = dict(line.split("=", 1) for line in outputs.read_text().splitlines())
                self.assertEqual(lines["remaining"], remaining)
                self.assertEqual(lines["reused"], str(verdict.reused).lower())

    def test_invalid_required_fails_the_step(self):
        for required in ('{"lint": 1}', '["lint", 2]', '[""]', "[not json"):
            with self.subTest(required=required), patch.dict(os.environ, {"INPUT_REQUIRED": required}), \
                    self.assertRaises(ValueError):
                self.verify()

    def test_a_red_base_never_reuses(self):
        # The scope measured the push from base; if base did not pass, a job
        # the change does not touch may be the one failing, and reusing the
        # rest would make this push the next green base with it unchecked.
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
                self.assertIs(self.verdict.green_base, False)
                self.assertIn("has no green run of ci.yml", reason)
                self.assertEqual(len(api.calls), 1, "no pull request lookup on a red base")
        (reused, reason), _ = self.verify(trunk=[self.trunk_run(event="schedule")])
        self.assertTrue(reused, reason)
        # A dispatch can run a reduced subset through its inputs.
        for event in ("workflow_dispatch", "merge_group"):
            with self.subTest(event=event):
                (reused, reason), _ = self.verify(trunk=[self.trunk_run(event=event)])
                self.assertFalse(reused, reason)

    def test_a_green_base_older_than_the_parent_reuses(self):
        green = "6" * 40
        cases = {
            # A path-filtered workflow did not run on the parent at all.
            "path-filtered workflow": ({}, [self.trunk_run(head_sha=green)]),
            # The previous push's run had not finished when this one landed.
            "parent run in progress": ({}, [self.trunk_run(head_sha=self.fixture.base, status="in_progress", conclusion=None),
                                            self.trunk_run(id=31, head_sha=green)]),
            # A release workflow calls ci.yml; its green runs on main are nightly ones.
            "called workflow": ({"INPUT_WORKFLOW": "ci.yml"}, [self.trunk_run(head_sha=green, event="schedule")]),
        }
        for name, (inputs, trunk) in cases.items():
            with self.subTest(name), patch.dict(os.environ, {"INPUT_BASE": green, "INPUT_REQUIRED": '["lint", "test"]', **inputs}):
                receipt = self.receipt()
                caller = f"{REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
                env = self.push_env(GITHUB_WORKFLOW_REF=caller) if inputs else self.push_env()
                (reused, reason), api = self.verify(env=env, trunk=trunk, receipt=receipt)
                self.assertTrue(reused, reason)
                self.assertIs(self.verdict.green_base, True)
                self.assertEqual(api.calls[0], ("actions/workflows/ci.yml/runs",
                                                {"head_sha": green, "branch": "main", "status": "success", "per_page": 100}))
                self.assertIn("on green base " + green, reason)

    def test_without_selections_the_parent_must_be_green(self):
        # A caller that passes no selections (v1.8.0 to v1.10.0) cannot show
        # that the pull request checked what a push measured from an older
        # base needs, so base is ignored and the merge's parent must be green.
        with patch.dict(os.environ, {"INPUT_SELECTIONS": "", "INPUT_BASE": "6" * 40}):
            receipt = self.receipt()
            (reused, reason), api = self.verify(receipt=receipt)
            self.assertTrue(reused, reason)
            self.assertIs(self.verdict.green_base, True)
            self.assertEqual(api.calls[0][1]["head_sha"], self.fixture.base, "the parent, not base")
            (reused, reason), _ = self.verify(receipt=receipt, trunk=[self.trunk_run(head_sha="6" * 40)])
            self.assertFalse(reused, reason)
            self.assertIn("(no selections given)", reason)

    def test_a_full_scope_needs_no_base(self):
        # The scope selected every job (no green run to measure from): each
        # job checks everything, so it passed whole on this tree or runs.
        with patch.dict(os.environ, {"INPUT_BASE": ""}):
            (reused, reason), api = self.verify(trunk=[])
            self.assertTrue(reused, reason)
            self.assertIsNone(self.verdict.green_base)
            self.assertEqual([call[1].get("event") for call in api.calls], ["pull_request"], "no trunk lookup")

    def test_unscoped_checks_no_trunk_run(self):
        # The pull request ran every job on this tree.
        with patch.dict(os.environ, {"INPUT_REQUIRED": "", "INPUT_SELECTIONS": ""}):
            (reused, reason), api = self.verify(trunk=[])
            self.assertTrue(reused, reason)
            self.assertIsNone(self.verdict.green_base)
            self.assertEqual([call[1].get("event") for call in api.calls], ["pull_request"])

    def test_a_job_is_reused_only_where_the_pull_request_checked_as_much(self):
        cases = {
            "same packages": ({"go": ["a", "b"]}, {"go": ["a", "b"]}, []),
            "fewer packages": ({"go": ["a", "b"]}, {"go": ["a"]}, []),
            "a package the pull request did not check": ({"go": ["b"]}, {"go": ["a", "b"]}, ["go"]),
            "the pull request checked everything": ({"go": "all"}, {"go": ["a", "c"]}, []),
            "the push needs everything": ({"go": ["a", "b"]}, {"go": "all"}, ["go"]),
            "no recorded selection": ({}, {"go": ["a"]}, ["go"]),
            "no push selection for the job": ({"go": ["a"]}, {}, ["go"]),
        }
        results = json.dumps({"go": {"result": "success"}})
        for name, (recorded, needed, remaining) in cases.items():
            with self.subTest(name), patch.dict(os.environ, {"INPUT_RESULTS": results, "INPUT_SELECTIONS": json.dumps(recorded)}):
                receipt = self.receipt()
                with patch.dict(os.environ, {"INPUT_REQUIRED": '["go"]', "INPUT_SELECTIONS": json.dumps(needed)}):
                    (reused, reason), _ = self.verify(receipt=receipt)
                self.assertEqual(self.verdict.remaining, remaining, reason)
                self.assertEqual(reused, not remaining)

    def test_a_reduced_run_the_scope_did_not_select_satisfies_nothing(self):
        # foundry and pkg run check lint-only on a pull request whose scope did
        # not select it: the receipt shows check passed with no selection.
        results = json.dumps({"check": {"result": "success"}, "lint": {"result": "success"}})
        with patch.dict(os.environ, {"INPUT_RESULTS": results, "INPUT_SELECTIONS": json.dumps({"lint": "all"})}):
            receipt = self.receipt()
        self.assertEqual(receipt["passed"], ["check", "lint"])
        for needed in ("all", ["example.com/m/a"]):
            with self.subTest(needed=needed), patch.dict(os.environ, {"INPUT_REQUIRED": '["check", "lint"]',
                                                                       "INPUT_SELECTIONS": json.dumps({"check": needed, "lint": "all"})}):
                (reused, reason), _ = self.verify(receipt=receipt)
                self.assertFalse(reused, reason)
                self.assertEqual(self.verdict.remaining, ["check"])
        self.assertTrue(acceptance.covers(None, []), "an empty selection needs no evidence")

    def test_invalid_selections_fail_the_step(self):
        for selections in ('["go"]', '{"go": "some"}', '{"go": [1]}', '{"bad id": "all"}', "{not json"):
            with self.subTest(selections=selections), patch.dict(os.environ, {"INPUT_SELECTIONS": selections}), \
                    self.assertRaises(ValueError):
                self.verify()

    def test_invalid_base_fails_the_step(self):
        for base in ("abc", "G" * 40, "a" * 39):
            with self.subTest(base=base), patch.dict(os.environ, {"INPUT_BASE": base}), self.assertRaises(ValueError):
                self.verify()

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

        reused, reason, green_base, remaining = acceptance.verify(self.push_env(), api=Broken(),
                                                                    receipts=lambda run, name: None, now=lambda: NOW)
        self.assertIsNone(remaining, "every required job runs")
        self.assertFalse(reused)
        self.assertIsNone(green_base)
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


def tool(name):
    try:
        subprocess.run([name, "version" if name == "go" else "--version"], check=True, capture_output=True, timeout=30)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


@unittest.skipUnless((tool("go") and tool("node")) or os.environ.get("GITHUB_ACTIONS"), "needs go and node")
class ScopeAcceptanceScenario(unittest.TestCase):
    """The scope action and verify together over real history.

    Push X fails, so the last green run G stays before it. A pull request
    based on X merges as M. Its scoped run checked what X..M touches; the
    push of M is measured from G, so it needs what G..M touches.
    """

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self.handler())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.api = f"http://127.0.0.1:{server.server_address[1]}"

    def handler(self):
        scenario = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"workflow_runs": [{
                    "id": 30, "conclusion": "success", "head_branch": "main", "event": "push", "head_sha": scenario.green,
                    "head_repository": {"full_name": REPOSITORY}, "html_url": "https://github.com/owner/repo/actions/runs/30"}]})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args):
                pass

        return Handler

    def write(self, files):
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        git(self.repo, "add", ".")

    def history(self, x_change):
        git(self.repo, "init", "-q", "-b", "main")
        self.write({"go.mod": "module example.com/m\n\ngo 1.22\n", "state/state.go": "package state\n",
                    "media/media.go": "package media\n", "app/app.go": 'package app\n\nimport _ "example.com/m/media"\n',
                    ".github/workflows/ci.yml": "on: push\njobs:\n  scope:\n  go:\n"})
        git(self.repo, "commit", "-q", "-m", "G")
        self.green = git(self.repo, "rev-parse", "HEAD")
        self.write(x_change)
        git(self.repo, "commit", "-q", "-m", "X, whose push run failed")
        self.x = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write({"media/media.go": "package media\n\nconst Y = 1\n"})
        git(self.repo, "commit", "-q", "-m", "Y")
        self.y = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "main")
        git(self.repo, "merge", "-q", "--no-ff", "-m", "merge", "feature")
        self.merge = git(self.repo, "rev-parse", "HEAD")

    def scope(self, event, payload):
        event_path = self.root / (event + ".json")
        event_path.write_text(json.dumps(payload))
        output = self.root / (event + ".out")
        env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", str(self.root)), "GOFLAGS": "", "GOPROXY": "off",
               "GOTOOLCHAIN": "local", "GOCACHE": os.environ.get("GOCACHE") or str(self.root / "gocache"),
               "GOPATH": os.environ.get("GOPATH") or str(self.root / "gopath"),
               "GITHUB_API_URL": self.api, "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
               "GITHUB_RUN_ID": "42", "GITHUB_EVENT_NAME": event, "GITHUB_EVENT_PATH": str(event_path),
               "GITHUB_REF": "refs/heads/main", "GITHUB_WORKSPACE": str(self.repo), "GITHUB_OUTPUT": str(output),
               "RUNNER_TEMP": str(self.root), "INPUT_JOBS": json.dumps({"go": {"go": ["./..."]}}), "INPUT_SHARED": "",
               "INPUT_FULL": "false", "INPUT_FULL-LABEL": "full-ci", "INPUT_LOOKBACK": "20", "INPUT_GO-DIRECTORY": ".",
               "INPUT_GO-IGNORE": ".github/**", "INPUT_TOKEN": "tok"}
        subprocess.run(["node", str(LIB.parent / "scope" / "index.cjs")], cwd=self.repo, env=env, check=True,
                       capture_output=True, timeout=120)
        lines = output.read_text().split("\n")
        outputs, index = {}, 0
        while index < len(lines):
            if "<<" in lines[index]:
                name, delimiter = lines[index].split("<<", 1)
                end = lines.index(delimiter, index + 1)
                outputs[name] = "\n".join(lines[index + 1:end])
                index = end
            index += 1
        return outputs

    def verdict(self):
        pull = self.scope("pull_request", {"pull_request": {"head": {"sha": self.y}, "base": {"sha": self.x}, "labels": []}})
        push = self.scope("push", {})
        self.assertEqual((pull["base"], push["base"]), (self.x, self.green))
        common = {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_WORKFLOW_REF": f"{REPOSITORY}/{WORKFLOW}@refs/heads/main",
                  "GITHUB_SHA": self.merge, "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": str(self.root)}
        pull_event = self.root / "pull.json"
        pull_event.write_text(json.dumps({"pull_request": {"head": {"repo": {"full_name": REPOSITORY}, "sha": self.y},
                                                           "base": {"repo": {"full_name": REPOSITORY}}}}))
        push_event = self.root / "push.json"
        push_event.write_text(json.dumps({"before": self.x, "repository": {"default_branch": "main"}}))
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        with patch.dict(os.environ, {"INPUT_RESULTS": json.dumps({"go": {"result": "success"}}), "INPUT_WORKFLOW": "",
                                     "INPUT_NAME": "", "INPUT_VARIABLES": "{}", "INPUT_SELECTIONS": pull["selections"]}):
            receipt = acceptance.build_receipt({**common, "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(pull_event),
                                                "GITHUB_RUN_ID": "41", "GITHUB_REF": "refs/pull/7/merge"})
        run = {"id": 41, "run_attempt": 1, "head_sha": self.y, "event": "pull_request", "status": "completed",
               "conclusion": "success", "updated_at": iso(NOW - 600), "repository": {"full_name": REPOSITORY},
               "head_repository": {"full_name": REPOSITORY}}
        trunk = [{"id": 30, "head_sha": self.green, "head_branch": "main", "event": "push", "conclusion": "success",
                  "repository": {"full_name": REPOSITORY}}]
        with patch.dict(os.environ, {"INPUT_REQUIRED": push["jobs"], "INPUT_BASE": push["base"], "INPUT_SELECTIONS": push["selections"],
                                     "INPUT_WORKFLOW": "", "INPUT_NAME": "", "INPUT_VARIABLES": "{}"}):
            return acceptance.verify({**common, "GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(push_event),
                                      "GITHUB_RUN_ID": "42", "GITHUB_REF": "refs/heads/main"},
                                     api=FakeAPI([run], trunk), receipts=lambda run, name: receipt, now=lambda: NOW), receipt

    def test_a_red_commit_the_pull_request_did_not_check_is_not_reused(self):
        # X broke state; the pull request touches only media.
        self.history({"state/state.go": "package state\n\nconst X = 1\n"})
        verdict, receipt = self.verdict()
        self.assertEqual(receipt["selections"], {"go": ["example.com/m/app", "example.com/m/media"]})
        self.assertFalse(verdict.reused, verdict.reason)
        self.assertEqual(verdict.remaining, ["go"])

    def test_extra_commits_the_pull_request_covered_are_reused(self):
        # X touched only media, which the pull request's run checked too.
        self.history({"media/extra.go": "package media\n\nconst X = 1\n"})
        verdict, _ = self.verdict()
        self.assertTrue(verdict.reused, verdict.reason)
        self.assertEqual(verdict.remaining, [])
