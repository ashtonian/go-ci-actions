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
import urllib.error
import zipfile

LIB = Path(__file__).parents[1] / "lib"
sys.path.insert(0, str(LIB))
spec = importlib.util.spec_from_file_location("acceptance", LIB / "acceptance.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

REPOSITORY = "owner/repo"
WORKFLOW = ".github/workflows/ci.yml"
NOW = 1_800_000_000
CI = """on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  scope:
  lint:
  test:
  image:
  go:
  check:
  accepted:
"""


def git(cwd, *args, env=None):
    # A throwaway fixture repository: no signing, a fixed identity.
    return subprocess.check_output(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.com",
                                    "-c", "commit.gpgsign=false", *args], cwd=cwd, text=True,
                                   env={**os.environ, **(env or {})}).strip()


def iso(timestamp):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def commit_document(cwd, sha, date):
    """GET git/commits/{sha} as GitHub answers it, with the committer date given."""
    tree, *parents = git(cwd, "show", "-s", "--format=%T %P", sha).split()
    return {"sha": sha, "tree": {"sha": tree}, "parents": [{"sha": parent} for parent in parents],
            "committer": {"name": "GitHub", "email": "noreply@github.com", "date": date}}


class Fixture:
    """A repository whose HEAD merges a branch into main, as a merge button would.

    pull_merge is GitHub's test merge the pull request's run checked: the same
    parents and tree as the merge the push lands, but another commit.
    """

    def __init__(self, root, workflow=CI):
        self.root = root
        git(root, "init", "-q", "-b", "main")
        (root / "a.txt").write_text("base\n")
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / WORKFLOW).write_text(workflow)
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
        self.pull_merge = git(root, "commit-tree", self.tree, "-p", self.base, "-p", self.head,
                              "-m", f"Merge {self.head} into {self.base}",
                              env={"GIT_COMMITTER_DATE": "@1700000000 +0000", "GIT_AUTHOR_DATE": "@1700000000 +0000"})


def job(name, conclusion):
    return {"name": name, "conclusion": conclusion}


class FakeAPI:
    """GitHub's answers: validation and trunk runs, commits, and each run's jobs."""

    def __init__(self, runs, trunk, commits, jobs):
        self.runs = runs
        self.trunk = trunk
        self.commits = commits
        self.jobs = jobs
        self.calls = []

    def get(self, path, **query):
        self.calls.append((path, query))
        if path.startswith("git/commits/"):
            sha = path.rsplit("/", 1)[1]
            if sha not in self.commits:
                raise urllib.error.HTTPError(path, 404, "Not Found", {}, io.BytesIO(b'{"message": "Not Found"}'))
            return self.commits[sha]
        if path.startswith("actions/runs/"):
            jobs = self.jobs.get(int(path.split("/")[2]), [])
            page, size = query.get("page", 1), query.get("per_page", 100)
            return {"total_count": len(jobs), "jobs": jobs[(page - 1) * size:page * size]}
        # The green-run lookups ask for successful runs; the validation lookup does not.
        return {"workflow_runs": self.trunk if query.get("status") == "success" else self.runs}


class Harness(unittest.TestCase):
    """A pull request run (41) that validated the merge a push (42) lands, as GitHub shows them."""

    workflow = CI

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.fixture = Fixture(self.repo, self.workflow)
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        self.inputs = {"INPUT_VARIABLES": json.dumps({"MACOS_CI": "off"}), "INPUT_WORKFLOW": "", "INPUT_NAME": "",
                       "INPUT_MAX_AGE_HOURS": "",
                       "INPUT_RESULTS": json.dumps({"lint": {"result": "success"}, "test": {"result": "success"}})}
        # A scoped caller: the push requires lint and test, measured from the
        # merge's parent (the last green run), and both check everything.
        self.inputs.update({"INPUT_BASE": self.fixture.base, "INPUT_REQUIRED": '["lint", "test"]',
                            "INPUT_SELECTIONS": json.dumps({"lint": "all", "test": "all"}), "INPUT_PARENT_SELECTIONS": ""})
        patcher = patch.dict(os.environ, self.inputs)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.jobs = {41: [job("scope", "success"), job("lint", "success"), job("test", "success"),
                          job("image", "skipped"), job("accepted", "success")]}
        self.commits = {self.fixture.pull_merge: commit_document(self.repo, self.fixture.pull_merge, iso(NOW - 700)),
                        self.fixture.head: commit_document(self.repo, self.fixture.head, iso(NOW - 800))}

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
        return self.env("pull_request", payload, GITHUB_REF="refs/pull/7/merge", GITHUB_SHA=self.fixture.pull_merge)

    def push_env(self, before=None, **extra):
        payload = {"before": before or self.fixture.base, "repository": {"default_branch": "main"}}
        return self.env("push", payload, GITHUB_RUN_ID="42", **extra)

    def checked_out(self, sha, build):
        git(self.repo, "checkout", "-q", sha)
        try:
            return build()
        finally:
            git(self.repo, "checkout", "-q", "main")

    def receipt(self):
        return self.checked_out(self.fixture.pull_merge, lambda: acceptance.build_receipt(self.pull_env()))

    def run_record(self, **fields):
        run = {"id": 41, "run_attempt": 1, "head_sha": self.fixture.head, "event": "pull_request",
               "status": "completed", "conclusion": "success", "created_at": iso(NOW - 690), "updated_at": iso(NOW - 600),
               "html_url": "https://github.com/owner/repo/actions/runs/41",
               "repository": {"full_name": REPOSITORY}, "head_repository": {"full_name": REPOSITORY}}
        run.update(fields)
        return run

    def trunk_run(self, **fields):
        run = {"id": 30, "head_sha": self.fixture.base, "head_branch": "main", "event": "push", "status": "completed",
               "conclusion": "success", "repository": {"full_name": REPOSITORY}}
        run.update(fields)
        return run

    def verify(self, env=None, runs=None, receipt=None, trunk=None, jobs=None, commits=None):
        receipt = self.receipt() if receipt is None else receipt
        api = FakeAPI([self.run_record()] if runs is None else runs, [self.trunk_run()] if trunk is None else trunk,
                      self.commits if commits is None else commits, self.jobs if jobs is None else jobs)
        self.verdict = acceptance.verify(env or self.push_env(), api=api,
                                         receipts=lambda run, name: receipt if receipt != "missing" else None,
                                         now=lambda: NOW)
        return (self.verdict.reused, self.verdict.reason), api


class AcceptanceTests(Harness):
    def test_receipt_names_only_the_commit_the_run_checked(self):
        receipt = self.receipt()
        self.assertEqual(receipt["source"], {"sha": self.fixture.pull_merge, "parents": [self.fixture.base, self.fixture.head],
                                             "tree": self.fixture.tree})
        self.assertEqual((receipt["version"], receipt["workflow"], receipt["run_id"]), (2, WORKFLOW, 41))
        # Which jobs passed and what they selected come from GitHub and the push's scope.
        self.assertFalse({"passed", "skipped", "selections"} & receipt.keys())

    def test_record_refuses_unproven_validation(self):
        cases = {
            "push event": lambda: acceptance.build_receipt(self.push_env()),
            "fork pull request": lambda: self.checked_out(self.fixture.pull_merge,
                                                          lambda: acceptance.build_receipt(self.pull_env(head_repo="someone/repo"))),
            "checkout of another head": lambda: self.checked_out(self.fixture.pull_merge,
                                                                 lambda: acceptance.build_receipt(self.pull_env(head_sha="0" * 40))),
            "checkout of another commit than the event's": lambda: acceptance.build_receipt(self.pull_env()),
        }
        for name, build in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                build()
        for results in ({"lint": {"result": "success"}, "test": {"result": "failure"}},
                        {"lint": {"result": "success"}, "test": {"result": "cancelled"}},
                        {"lint": "success"}, {}):
            with self.subTest(results=results), patch.dict(os.environ, {"INPUT_RESULTS": json.dumps(results)}), \
                    self.assertRaises(ValueError):
                self.receipt()

    def test_record_uploads_one_receipt_file(self):
        uploaded = {}

        def upload(store, name, patterns, retention, missing):
            uploaded.update(name=name, body=json.loads(Path(patterns).read_text()), retention=retention, missing=missing)

        with patch.object(acceptance.artifact, "upload", upload):
            self.checked_out(self.fixture.pull_merge, lambda: acceptance.record(self.pull_env(), store=object()))
        self.assertEqual(uploaded["name"], "acceptance")
        self.assertEqual(uploaded["body"]["source"]["sha"], self.fixture.pull_merge)
        self.assertEqual((uploaded["retention"], uploaded["missing"]), (7, "error"))

    def test_the_pull_requests_validation_of_this_merge_is_reused(self):
        (reused, reason), api = self.verify()
        self.assertTrue(reused, reason)
        self.assertIn(self.fixture.tree, reason)
        self.assertTrue(self.verdict.green_base)
        self.assertEqual(api.calls, [
            ("actions/workflows/ci.yml/runs",
             {"head_sha": self.fixture.base, "branch": "main", "status": "success", "per_page": 100}),
            ("actions/workflows/ci.yml/runs", {"head_sha": self.fixture.head, "per_page": 100}),
            ("git/commits/" + self.fixture.pull_merge, {}),
            ("actions/runs/41/jobs", {"filter": "latest", "per_page": 100, "page": 1})])

    def test_called_workflow_names_its_own_file(self):
        with patch.dict(os.environ, {"INPUT_WORKFLOW": "ci.yml"}):
            receipt = self.receipt()
            caller = f"{REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
            (reused, reason), api = self.verify(env=self.push_env(GITHUB_WORKFLOW_REF=caller), receipt=receipt)
        self.assertTrue(reused, reason)
        self.assertEqual({call[0] for call in api.calls if "workflows" in call[0]}, {"actions/workflows/ci.yml/runs"})

    def test_anything_short_of_githubs_evidence_runs_every_check(self):
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
            "run older than the receipts' retention": {"runs": [self.run_record(updated_at=iso(NOW - 169 * 3600))]},
            "no receipt": {"receipt": "missing"},
            "a version 1 receipt": {"receipt": {**receipt, "version": 1}},
            "other variables": {"receipt": {**receipt, "variables": "4" * 64}},
            "other workflow": {"receipt": {**receipt, "workflow": ".github/workflows/other.yml"}},
            "other run attempt": {"receipt": {**receipt, "run_attempt": 2}},
            "other run": {"receipt": {**receipt, "run_id": 40}},
            "other event": {"receipt": {**receipt, "event": "workflow_dispatch"}},
            "no commit": {"receipt": {**receipt, "source": {}}},
            "a commit GitHub does not have": {"receipt": {**receipt, "source": {"sha": "5" * 40}}},
        }
        for name, case in cases.items():
            with self.subTest(name):
                (reused, reason), _ = self.verify(**case)
                self.assertFalse(reused, reason)
                self.assertIsNone(self.verdict.remaining, "every required job runs")

    def test_a_receipt_names_a_commit_github_shows_as_this_merge_checked_before_the_run(self):
        # The receipt is written by a job of the pull request run, so its
        # contents prove nothing: verify reads the commit it names from GitHub.
        doc = self.commits[self.fixture.pull_merge]
        stale_base = {**doc, "parents": [{"sha": "6" * 40}, {"sha": self.fixture.head}]}
        cases = {
            # The run checked the head merged into an older base.
            "merged into another base": (stale_base, "into 6666"),
            "another head": ({**doc, "parents": [{"sha": self.fixture.base}, {"sha": "7" * 40}]}, "not into this push's parent"),
            "another tree": ({**doc, "tree": {"sha": "8" * 40}}, "another tree"),
            # GitHub's merge for the push, or one created once the base moved: not what the run checked out.
            "created after the run started": ({**doc, "committer": {**doc["committer"], "date": iso(NOW - 680)}}, "after its run started"),
        }
        for name, (document, mentioned) in cases.items():
            with self.subTest(name):
                (reused, reason), _ = self.verify(commits={**self.commits, self.fixture.pull_merge: document})
                self.assertFalse(reused, reason)
                self.assertIn(mentioned, reason)
        # The receipt's own copy of parents and tree is not read.
        receipt = self.receipt()
        forged = {**receipt, "source": {**receipt["source"], "parents": ["9" * 40], "tree": "9" * 40}}
        (reused, reason), _ = self.verify(receipt=forged)
        self.assertTrue(reused, reason)

    def test_which_jobs_passed_comes_from_the_runs_jobs_not_the_receipt(self):
        # A forged receipt claims everything passed; GitHub shows test failed.
        receipt = {**self.receipt(), "passed": ["lint", "test"], "skipped": [], "selections": {"test": "all"}}
        jobs = {41: [job("scope", "success"), job("lint", "success"), job("test", "failure"), job("accepted", "success")]}
        (reused, reason), _ = self.verify(receipt=receipt, jobs=jobs)
        self.assertFalse(reused, reason)
        self.assertEqual(self.verdict.remaining, ["test"])
        self.assertIn("passed lint", reason)
        cases = {
            "a job the run skipped": [job("lint", "success"), job("test", "skipped")],
            "a job the run does not show": [job("lint", "success")],
            "a matrix leg that failed": [job("lint", "success"), job("test (linux)", "success"), job("test (macos)", "failure")],
            "a called workflow whose jobs all skipped": [job("lint", "success"), job("test / unit", "skipped")],
            "a cancelled job": [job("lint", "success"), job("test", "cancelled")],
        }
        for name, shown in cases.items():
            with self.subTest(name):
                (reused, reason), _ = self.verify(jobs={41: shown})
                self.assertEqual(self.verdict.remaining, ["test"], reason)
        for shown in ([job("lint", "success"), job("test (linux)", "success"), job("test (macos)", "skipped")],
                      [job("lint", "success"), job("test / unit", "success"), job("test / race", "skipped")]):
            with self.subTest(shown=shown):
                (reused, reason), _ = self.verify(jobs={41: shown})
                self.assertTrue(reused, reason)

    def test_jobs_are_read_across_pages(self):
        many = [job(f"test (shard {n})", "success") for n in range(150)] + [job("lint", "success")]
        (reused, reason), api = self.verify(jobs={41: many})
        self.assertTrue(reused, reason)
        self.assertEqual([call[1]["page"] for call in api.calls if call[0].endswith("/jobs")], [1, 2])
        (reused, reason), _ = self.verify(jobs={41: many[:100] + [job("test (shard x)", "failure")] + many[100:]})
        self.assertEqual(self.verdict.remaining, ["test"], reason)

    def test_reuse_needs_every_required_job_to_have_passed(self):
        cases = {
            "": (False, "image", None),
            '["lint"]': (True, "", []),
            "lint\nscope\n": (True, "", []),
            "[]": (True, "", []),
            '["lint", "image"]': (False, "runs image", ["image"]),
            '["go"]': (False, "runs go", ["go"]),
        }
        everything = json.dumps({"scope": "all", "lint": "all", "image": "all", "go": "all"})
        for required, (expected, mentioned, remaining) in cases.items():
            with self.subTest(required=required), patch.dict(os.environ, {"INPUT_REQUIRED": required, "INPUT_SELECTIONS": everything}):
                (reused, reason), _ = self.verify()
                self.assertEqual(reused, expected, reason)
                self.assertIn(mentioned, reason)
                self.assertEqual(self.verdict.remaining, remaining)

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

    def test_invalid_inputs_fail_the_step(self):
        cases = [("INPUT_REQUIRED", value) for value in ('{"lint": 1}', '["lint", 2]', '[""]', "[not json")]
        cases += [(name, value) for name in ("INPUT_SELECTIONS", "INPUT_PARENT_SELECTIONS")
                  for value in ('["go"]', '{"go": "some"}', '{"go": [1]}', '{"bad id": "all"}', "{not json")]
        cases += [("INPUT_BASE", value) for value in ("abc", "G" * 40, "a" * 39)]
        cases += [("INPUT_MAX_AGE_HOURS", value) for value in ("0", "-1", "169", "x")]
        for name, value in cases:
            with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}), self.assertRaises(ValueError):
                self.verify()

    def test_max_age_bounds_the_validation_run(self):
        runs = [self.run_record(updated_at=iso(NOW - 7 * 3600))]
        (reused, reason), _ = self.verify(runs=runs)
        self.assertTrue(reused, "the default is the receipts' retention: " + reason)
        with patch.dict(os.environ, {"INPUT_MAX_AGE_HOURS": "6"}):
            (reused, reason), _ = self.verify(runs=runs)
        self.assertFalse(reused, reason)
        self.assertIn("older than max-age-hours", reason)

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

    def test_a_green_base_older_than_the_parent_reuses_what_the_parents_scope_covers(self):
        green = "6" * 40
        everything = json.dumps({"lint": "all", "test": "all"})
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
            with self.subTest(name), patch.dict(os.environ, {"INPUT_BASE": green, "INPUT_PARENT_SELECTIONS": everything, **inputs}):
                receipt = self.receipt()
                caller = f"{REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
                env = self.push_env(GITHUB_WORKFLOW_REF=caller) if inputs else self.push_env()
                (reused, reason), api = self.verify(env=env, trunk=trunk, receipt=receipt)
                self.assertTrue(reused, reason)
                self.assertIs(self.verdict.green_base, True)
                self.assertEqual(api.calls[0], ("actions/workflows/ci.yml/runs",
                                                {"head_sha": green, "branch": "main", "status": "success", "per_page": 100}))
                self.assertIn("on green base " + green, reason)
        # Without the parent's selections nothing shows what the pull request checked.
        with patch.dict(os.environ, {"INPUT_BASE": green}):
            (reused, reason), _ = self.verify(trunk=[self.trunk_run(head_sha=green)])
        self.assertFalse(reused, reason)
        self.assertEqual(self.verdict.remaining, ["lint", "test"])

    def test_without_selections_the_parent_must_be_green(self):
        # A caller that passes no selections cannot show that the pull request
        # checked what a push measured from an older base needs, so base is
        # ignored and the merge's parent must be green.
        with patch.dict(os.environ, {"INPUT_SELECTIONS": "", "INPUT_BASE": "6" * 40}):
            (reused, reason), api = self.verify()
            self.assertTrue(reused, reason)
            self.assertIs(self.verdict.green_base, True)
            self.assertEqual(api.calls[0][1]["head_sha"], self.fixture.base, "the parent, not base")
            (reused, reason), _ = self.verify(trunk=[self.trunk_run(head_sha="6" * 40)])
            self.assertFalse(reused, reason)
            self.assertIn("(no selections given)", reason)

    def test_a_full_scope_needs_no_base(self):
        # The scope selected every job (no green run to measure from): each
        # job must have checked everything in the pull request too.
        with patch.dict(os.environ, {"INPUT_BASE": "", "INPUT_PARENT_SELECTIONS": json.dumps({"lint": "all", "test": "all"})}):
            (reused, reason), api = self.verify(trunk=[])
            self.assertTrue(reused, reason)
            self.assertIsNone(self.verdict.green_base)
            self.assertNotIn("success", [call[1].get("status") for call in api.calls], "no trunk lookup")
        with patch.dict(os.environ, {"INPUT_BASE": "", "INPUT_PARENT_SELECTIONS": json.dumps({"lint": "all", "test": ["a"]})}):
            (reused, reason), _ = self.verify(trunk=[])
            self.assertEqual(self.verdict.remaining, ["test"], reason)

    def test_unscoped_needs_every_job_of_the_run_to_pass(self):
        with patch.dict(os.environ, {"INPUT_REQUIRED": "", "INPUT_SELECTIONS": ""}):
            jobs = {41: [job("lint", "success"), job("test", "success"), job("accepted", "success")]}
            (reused, reason), api = self.verify(trunk=[], jobs=jobs)
            self.assertTrue(reused, reason)
            self.assertIsNone(self.verdict.green_base)
            self.assertNotIn("success", [call[1].get("status") for call in api.calls])
            (reused, reason), _ = self.verify(trunk=[])
            self.assertFalse(reused, reason)
            self.assertIn("image", reason)

    def test_a_job_is_reused_only_where_the_pull_request_checked_as_much(self):
        cases = {
            "same packages": ({"go": ["a", "b"]}, {"go": ["a", "b"]}, []),
            "fewer packages": ({"go": ["a", "b"]}, {"go": ["a"]}, []),
            "a package the pull request did not check": ({"go": ["b"]}, {"go": ["a", "b"]}, ["go"]),
            "the pull request checked everything": ({"go": "all"}, {"go": ["a", "c"]}, []),
            "the push needs everything": ({"go": ["a", "b"]}, {"go": "all"}, ["go"]),
            "the pull request's scope did not select it": ({}, {"go": ["a"]}, ["go"]),
            "no push selection for the job": ({"go": ["a"]}, {}, ["go"]),
        }
        jobs = {41: [job("go", "success")]}
        for name, (parent, needed, remaining) in cases.items():
            with self.subTest(name), patch.dict(os.environ, {"INPUT_REQUIRED": '["go"]', "INPUT_SELECTIONS": json.dumps(needed),
                                                             "INPUT_PARENT_SELECTIONS": json.dumps(parent)}):
                (reused, reason), _ = self.verify(jobs=jobs)
                self.assertEqual(self.verdict.remaining, remaining, reason)
                self.assertEqual(reused, not remaining)

    def test_a_reduced_run_the_scope_did_not_select_satisfies_nothing(self):
        # foundry and pkg run check lint-only on a pull request whose scope did
        # not select it: GitHub shows check passed, the parent's scope has no
        # selection for it.
        jobs = {41: [job("check", "success"), job("lint", "success")]}
        for needed in ("all", ["example.com/m/a"]):
            with self.subTest(needed=needed), patch.dict(os.environ, {
                    "INPUT_REQUIRED": '["check", "lint"]', "INPUT_SELECTIONS": json.dumps({"check": needed, "lint": "all"}),
                    "INPUT_PARENT_SELECTIONS": json.dumps({"lint": "all"})}):
                (reused, reason), _ = self.verify(jobs=jobs)
                self.assertFalse(reused, reason)
                self.assertEqual(self.verdict.remaining, ["check"])
        self.assertTrue(acceptance.covers(None, []), "an empty selection needs no evidence")

    def dispatch_receipt(self, ref="refs/heads/feature"):
        # A run dispatched on the pull request's branch checks out its head.
        return self.checked_out(self.fixture.head, lambda: acceptance.build_receipt(
            self.env("workflow_dispatch", {"ref": ref}, GITHUB_SHA=self.fixture.head, GITHUB_REF=ref)))

    def test_a_dispatched_validation_of_the_head_serves_its_merge(self):
        # A bot's pull request run cannot start, so the owner dispatches the
        # workflow on its branch; the branch contains main, so the merge has
        # the head's tree.
        self.assertEqual(git(self.repo, "rev-parse", self.fixture.head + "^{tree}"), self.fixture.tree)
        receipt = self.dispatch_receipt()
        self.assertEqual((receipt["event"], receipt["source"]["sha"]), ("workflow_dispatch", self.fixture.head))
        dispatched = self.run_record(event="workflow_dispatch", head_branch="feature", head_sha=self.fixture.head)
        # A dispatch runs every job in full: the push's selections need no comparison.
        with patch.dict(os.environ, {"INPUT_BASE": "6" * 40, "INPUT_SELECTIONS": json.dumps({"lint": ["a"], "test": "all"})}):
            (reused, reason), _ = self.verify(runs=[dispatched], receipt=receipt, trunk=[self.trunk_run(head_sha="6" * 40)])
        self.assertTrue(reused, reason)
        # The bot's pull request run ended in startup_failure before the dispatch.
        failed_start = self.run_record(id=40, conclusion="startup_failure", updated_at=iso(NOW - 1200), head_sha=self.fixture.head)
        (reused, reason), _ = self.verify(runs=[failed_start, dispatched], receipt=receipt)
        self.assertTrue(reused, reason)
        head_doc = self.commits[self.fixture.head]
        cases = {
            "the merge has another tree": ({**self.commits, self.fixture.head: {**head_doc, "tree": {"sha": "2" * 40}}},
                                           receipt, [dispatched]),
            "the dispatch names another commit": (self.commits, {**receipt, "source": {"sha": self.fixture.pull_merge}}, [dispatched]),
            "the receipt names another event": (self.commits, {**receipt, "event": "pull_request"}, [dispatched]),
            "a newer validation run failed": (self.commits, receipt, [dispatched, self.run_record(
                id=43, conclusion="failure", updated_at=iso(NOW - 60), head_sha=self.fixture.head)]),
        }
        for name, (commits, candidate, runs) in cases.items():
            with self.subTest(name):
                (reused, reason), _ = self.verify(runs=runs, receipt=candidate, commits=commits)
                self.assertFalse(reused, reason)

    def test_a_dispatch_records_only_a_branch_head(self):
        with self.assertRaises(ValueError):
            self.dispatch_receipt(ref="refs/tags/v1")
        with self.assertRaises(ValueError):
            # The checkout (the merge) is not the commit the run was dispatched on.
            acceptance.build_receipt(self.env("workflow_dispatch", {}, GITHUB_REF="refs/heads/feature",
                                              GITHUB_SHA=self.fixture.head))
        with self.assertRaises(ValueError):
            acceptance.build_receipt(self.env("schedule", {}))

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
        with patch.object(acceptance.artifact, "fetch", fetch({"acceptance.json": '{"version": 2}'})):
            self.assertEqual(acceptance.fetch_receipt(run, "acceptance", Store()), {"version": 2})
            self.assertIsNone(acceptance.fetch_receipt(run, "other", Store()))
        with patch.object(acceptance.artifact, "fetch", fetch({"acceptance.json": "{}", "extra": "x"})), \
                self.assertRaises(ValueError):
            acceptance.fetch_receipt(run, "acceptance", Store())


class NamedJobTests(Harness):
    """Jobs with display names and matrices: GitHub shows those names, not the job IDs."""

    workflow = CI.replace("  lint:\n", "  lint:\n    name: Lint\n").replace(
        "  test:\n", "  test:\n    name: \"test (go ${{ matrix.go }})\"\n")

    def setUp(self):
        super().setUp()
        self.jobs = {41: [job("scope", "success"), job("Lint", "success"), job("test (go 1.26)", "success"),
                          job("test (go 1.25)", "success"), job("image", "skipped"), job("accepted", "success")]}

    def test_display_names_map_to_their_jobs(self):
        (reused, reason), _ = self.verify()
        self.assertTrue(reused, reason)
        jobs = {41: [job("Lint", "success"), job("test (go 1.26)", "success"), job("test (go 1.25)", "failure")]}
        (reused, reason), _ = self.verify(jobs=jobs)
        self.assertEqual(self.verdict.remaining, ["test"], reason)
        # The job ID is not its display name.
        (reused, reason), _ = self.verify(jobs={41: [job("lint", "success"), job("test (go 1.26)", "success")]})
        self.assertEqual(self.verdict.remaining, ["lint"], reason)

    def test_names_two_jobs_could_show_are_evidence_for_neither(self):
        # A name the outline cannot read could be any job's.
        (self.repo / WORKFLOW).write_text(self.workflow.replace("  image:\n", "  image:\n    name: ${{ matrix.name }}\n"))
        (reused, reason), _ = self.verify()
        self.assertFalse(reused, reason)
        self.assertEqual(self.verdict.remaining, ["lint", "test"])
        self.assertIn("job names the run cannot tell apart", reason)


class WorkflowOutlineTests(unittest.TestCase):
    def test_job_names(self):
        import workflow_outline
        patterns = workflow_outline.job_name_patterns("""
jobs:
  plain:
  named:
    name: Build image   # a comment
  quoted:
    name: "go / race"
  matrixed:
    name: test (go ${{ matrix.go }}, ${{ matrix.os }})
  unreadable:
    name: ${{ inputs.label }}
  block:
    name: >-
      folded
""")
        cases = {
            "plain": (["plain", "plain (linux)", "plain / inner"], ["plainer", "x plain"]),
            "named": (["Build image", "Build image (arm64)"], ["named", "Build images"]),
            "quoted": (["go / race", "go / race / unit"], ["go / racer"]),
            "matrixed": (["test (go 1.26, linux)"], ["test (linux)", "tests"]),
            "unreadable": (["anything"], []),
            "block": (["anything"], []),
        }
        for job_id, (shown, other) in cases.items():
            with self.subTest(job_id):
                self.assertTrue(all(patterns[job_id].matches(name) for name in shown))
                self.assertFalse(any(patterns[job_id].matches(name) for name in other))

    def test_dispatch_inputs(self):
        import workflow_outline
        cases = {
            "on: workflow_dispatch\n": False,
            "on: [push, workflow_dispatch]\n": False,
            "on:\n  - push\n  - workflow_dispatch\n": False,
            "on:\n  push:\n  workflow_dispatch:\n": False,
            "on:\n  workflow_dispatch: {}\n": False,
            "on:\n  workflow_dispatch:\n    inputs: {}\n": False,
            "on:\n  workflow_dispatch:\n    inputs:\n      full:\n        type: boolean\n": True,
            "on:\n  workflow_dispatch: {inputs: {full: {type: boolean}}}\n": True,
            "on: push\n": True,
            "on:\n  push:\n": True,
            "jobs:\n": True,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(workflow_outline.dispatch_takes_inputs(text), expected)


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
    push of M is measured from G, so it needs what G..M touches, and the
    push's scope measures X..M again for comparison.
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
        # The push's scope measures the pull request's change itself.
        self.assertEqual(json.loads(push["parent-selections"]), json.loads(pull["selections"]))
        self.assertEqual(Path(push["parent-files"]).read_text(), Path(pull["files"]).read_text())
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
                                     "INPUT_NAME": "", "INPUT_VARIABLES": "{}"}):
            receipt = acceptance.build_receipt({**common, "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(pull_event),
                                                "GITHUB_RUN_ID": "41", "GITHUB_REF": "refs/pull/7/merge"})
        run = {"id": 41, "run_attempt": 1, "head_sha": self.y, "event": "pull_request", "status": "completed",
               "conclusion": "success", "created_at": iso(NOW - 690), "updated_at": iso(NOW - 600),
               "repository": {"full_name": REPOSITORY}, "head_repository": {"full_name": REPOSITORY}}
        trunk = [{"id": 30, "head_sha": self.green, "head_branch": "main", "event": "push", "conclusion": "success",
                  "repository": {"full_name": REPOSITORY}}]
        api = FakeAPI([run], trunk, {self.merge: commit_document(self.repo, self.merge, iso(NOW - 700))},
                      {41: [job("scope", "success"), job("go", "success")]})
        with patch.dict(os.environ, {"INPUT_REQUIRED": push["jobs"], "INPUT_BASE": push["base"], "INPUT_SELECTIONS": push["selections"],
                                     "INPUT_PARENT_SELECTIONS": push["parent-selections"], "INPUT_MAX_AGE_HOURS": "",
                                     "INPUT_WORKFLOW": "", "INPUT_NAME": "", "INPUT_VARIABLES": "{}"}):
            return acceptance.verify({**common, "GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(push_event),
                                      "GITHUB_RUN_ID": "42", "GITHUB_REF": "refs/heads/main"},
                                     api=api, receipts=lambda run, name: receipt, now=lambda: NOW), pull

    def test_a_red_commit_the_pull_request_did_not_check_is_not_reused(self):
        # X broke state; the pull request touches only media.
        self.history({"state/state.go": "package state\n\nconst X = 1\n"})
        verdict, pull = self.verdict()
        self.assertEqual(json.loads(pull["selections"]), {"go": ["example.com/m/app", "example.com/m/media"]})
        self.assertFalse(verdict.reused, verdict.reason)
        self.assertEqual(verdict.remaining, ["go"])

    def test_extra_commits_the_pull_request_covered_are_reused(self):
        # X touched only media, which the pull request's run checked too.
        self.history({"media/extra.go": "package media\n\nconst X = 1\n"})
        verdict, _ = self.verdict()
        self.assertTrue(verdict.reused, verdict.reason)
        self.assertEqual(verdict.remaining, [])
