#!/usr/bin/env python3
"""Reuse a pull request's passing validation for the push that merges the same tree.

record runs in a pull request run once its validation jobs pass, and stores a
receipt naming the tested merge commit's tree and which jobs passed. Jobs the
run's scope left out are recorded as skipped, not passed. verify runs first in
the push that merges the pull request: when the pushed merge commit carries the
same tree, the same workflow file and the same repository variables, and every
job the push requires passed in the pull request, those checks need not run
again.
"""

import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import typing
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import artifact

RECEIPT_VERSION = 1
RECEIPT_FILE = "acceptance.json"
MAX_RECEIPT = 128 * 1024
MAX_API_DOCUMENT = 4 * 1024 * 1024
API_TIMEOUT = 10
LOOKUP_DEADLINE = 100
RECEIPT_RETENTION_DAYS = 7
WORKFLOW_PATH = re.compile(r"\.github/workflows/[A-Za-z0-9._-]+\.ya?ml")
JOB_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
# Events whose successful runs on the default branch prove a commit green.
TRUNK_EVENTS = {"push", "schedule", "workflow_dispatch", "merge_group"}


def commit(ref="HEAD"):
    """The checked-out commit, read from its object so a shallow clone works."""
    sha = subprocess.check_output(["git", "rev-parse", "--verify", ref + "^{commit}"], timeout=15, text=True).strip()
    header = subprocess.check_output(["git", "cat-file", "commit", sha], timeout=15, text=True).split("\n\n", 1)[0]
    tree, parents = "", []
    for line in header.splitlines():
        key, _, value = line.partition(" ")
        if key == "tree":
            tree = value
        elif key == "parent":
            parents.append(value)
    if not tree:
        raise ValueError("commit object has no tree")
    return {"sha": sha, "parents": parents, "tree": tree}


def workflow_path(env):
    """The workflow file whose runs hold receipts: the input, else the running workflow."""
    name = artifact.input_value("workflow").strip()
    if name:
        path = name if name.startswith(".github/") else ".github/workflows/" + name
    else:
        ref = env.get("GITHUB_WORKFLOW_REF", "")
        prefix = env["GITHUB_REPOSITORY"] + "/"
        if not ref.startswith(prefix) or "@" not in ref:
            raise ValueError("GITHUB_WORKFLOW_REF does not name a workflow of this repository")
        path = ref[len(prefix):].split("@", 1)[0]
    if not WORKFLOW_PATH.fullmatch(path):
        raise ValueError("workflow must be a file under .github/workflows: " + path)
    return path


def variables_digest():
    raw = artifact.input_value("variables").strip() or "{}"
    variables = json.loads(raw)
    if not isinstance(variables, dict):
        raise ValueError("variables must be the vars context as JSON")
    return hashlib.sha256(json.dumps(variables, sort_keys=True).encode()).hexdigest()


def receipt_name():
    name = artifact.input_value("name", "acceptance") or "acceptance"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("invalid receipt name")
    return name


def event(env):
    return json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))


def build_receipt(env):
    """The receipt for this pull request run; raises when a validation job failed or was cancelled."""
    if env.get("GITHUB_EVENT_NAME") != "pull_request":
        raise ValueError("receipts record pull request validation only")
    pull = event(env)["pull_request"]
    repository = env["GITHUB_REPOSITORY"]
    if pull["head"]["repo"]["full_name"] != repository or pull["base"]["repo"]["full_name"] != repository:
        raise ValueError("only a pull request from this repository records a receipt")
    source = commit()
    if source["sha"] != env["GITHUB_SHA"] or len(source["parents"]) != 2 or source["parents"][1] != pull["head"]["sha"]:
        raise ValueError("the checkout is not this pull request's merge commit")
    results = json.loads(artifact.input_value("results") or "{}")
    if not isinstance(results, dict) or not results:
        raise ValueError("results must be the needs context of the validation jobs as JSON")
    outcome = {name: job.get("result") if isinstance(job, dict) else None for name, job in results.items()}
    failed = sorted(name for name, result in outcome.items() if result not in ("success", "skipped"))
    if failed:
        raise ValueError("validation did not pass: " + ", ".join(failed))
    return {"version": RECEIPT_VERSION, "repository": repository, "workflow": workflow_path(env),
            "run_id": int(env["GITHUB_RUN_ID"]), "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]),
            "source": source, "variables": variables_digest(),
            "passed": sorted(name for name, result in outcome.items() if result == "success"),
            "skipped": sorted(name for name, result in outcome.items() if result == "skipped")}


def required_jobs():
    """The jobs a push requires, or None for every job the receipt names.

    A JSON array (a scope action's output) or one job name per line. An empty
    array is a push whose scope selected nothing.
    """
    raw = artifact.input_value("required").strip()
    if not raw:
        return None
    names = json.loads(raw) if raw.startswith("[") else [line.strip() for line in raw.splitlines() if line.strip()]
    if not isinstance(names, list) or not all(isinstance(name, str) and JOB_ID.fullmatch(name) for name in names):
        raise ValueError("required must name job IDs, as a JSON array or one per line")
    return sorted(set(names))


def record(env, store=None):
    receipt = build_receipt(env)
    name = receipt_name()
    directory = Path(tempfile.mkdtemp(prefix="acceptance-", dir=env.get("RUNNER_TEMP")))
    path = directory / RECEIPT_FILE
    path.write_text(json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8")
    if store is None:
        artifact.setup()
        store = artifact.Store()
    artifact.upload(store, name, str(path), RECEIPT_RETENTION_DAYS, missing="error")
    skipped = f"; skipped: {', '.join(receipt['skipped'])}" if receipt["skipped"] else ""
    print(f"recorded {name} for tree {receipt['source']['tree']} (passed: {', '.join(receipt['passed']) or 'none'}{skipped})")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    """Read-only REST calls with the job token, under one lookup deadline."""

    def __init__(self, env):
        self.base = env.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
        self.repository = env["GITHUB_REPOSITORY"]
        self.token = env["GITHUB_TOKEN"]
        self.opener = urllib.request.build_opener(NoRedirect)
        self.deadline = time.monotonic() + LOOKUP_DEADLINE

    def get(self, path, **query):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("acceptance lookup deadline")
        url = f"{self.base}/repos/{self.repository}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "Authorization": "Bearer " + self.token}
        with self.opener.open(urllib.request.Request(url, headers=headers), timeout=min(API_TIMEOUT, remaining)) as response:
            data = response.read(MAX_API_DOCUMENT + 1)
        if len(data) > MAX_API_DOCUMENT:
            raise ValueError("oversized API response")
        return json.loads(data)


def fetch_receipt(run, name, store=None):
    """The named receipt the run's final attempt stored, or None when it stored none."""
    if store is None:
        artifact.setup()
        store = artifact.Store()
    item = next((item for item in store.manifests(str(run["id"]), str(run["run_attempt"])) if item["name"] == name), None)
    if item is None:
        return None
    with tempfile.TemporaryDirectory(prefix="acceptance-") as directory:
        archive = Path(directory) / "receipt.zip"
        artifact.fetch(store, item, archive, MAX_RECEIPT)
        with zipfile.ZipFile(io.BytesIO(archive.read_bytes())) as bundle:
            if bundle.namelist() != [RECEIPT_FILE] or bundle.getinfo(RECEIPT_FILE).file_size > MAX_RECEIPT:
                raise ValueError("unexpected receipt archive")
            return json.loads(bundle.read(RECEIPT_FILE))


def updated_at(run):
    return datetime.datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00")).timestamp()


class Verdict(typing.NamedTuple):
    reused: bool
    reason: str
    # Whether the scope's base has a green trunk run of the workflow; None
    # when verify stopped before asking or was given no base.
    green_base: typing.Optional[bool] = None
    # The required jobs the push still runs; None is all of them.
    remaining: typing.Optional[list] = None


def green_runs(api, workflow, sha, branch, repository, run_id):
    """Successful trunk runs of the workflow on the branch at sha, other than this run."""
    runs = api.get(f"actions/workflows/{urllib.parse.quote(Path(workflow).name)}/runs",
                   head_sha=sha, branch=branch, status="success", per_page=100)["workflow_runs"]
    return [run for run in runs if run.get("head_sha") == sha and run.get("conclusion") == "success"
            and run.get("head_branch") == branch and run.get("event") in TRUNK_EVENTS
            and (run.get("repository") or {}).get("full_name") == repository and str(run.get("id")) != run_id]


def scope_base():
    """The commit the push's required jobs were measured from (the scope's base), or None."""
    raw = artifact.input_value("base").strip()
    if raw and not re.fullmatch(r"[0-9a-f]{40}", raw):
        raise ValueError("base must be a full commit SHA: the scope action's base output")
    return raw or None


def verify(env, api=None, receipts=fetch_receipt, now=time.time):
    """A Verdict. Anything short of a matching receipt on a green base runs the push's checks."""
    # An invalid input is a workflow error, not missing evidence: it fails the step.
    required = required_jobs()
    base = scope_base()
    if env.get("GITHUB_EVENT_NAME") != "push":
        return Verdict(False, "only a push reuses pull request validation")
    green_base = None
    try:
        payload = event(env)
        branch = payload["repository"]["default_branch"]
        if env.get("GITHUB_REF") != "refs/heads/" + branch:
            return Verdict(False, "only a push to the default branch reuses pull request validation")
        if env.get("GITHUB_RUN_ATTEMPT") != "1":
            return Verdict(False, "a rerun executes every check")
        source = commit()
        if (source["sha"] != env["GITHUB_SHA"] or len(source["parents"]) != 2
                or source["parents"][0] != payload.get("before")):
            return Verdict(False, "the push is not a single merge commit on the previous head")
        head = source["parents"][1]
        repository = env["GITHUB_REPOSITORY"]
        workflow = workflow_path(env)
        api = api or GitHub(env)
        # The push needs only the required jobs because every other job's
        # inputs are unchanged since base, so base must have passed them: a
        # required list measured from a red commit could leave out the job
        # that is failing, and reusing the rest would make this push the
        # next green base with that failure unchecked.
        if base is not None:
            green_base = bool(green_runs(api, workflow, base, branch, repository, env.get("GITHUB_RUN_ID", "")))
            if not green_base:
                return Verdict(False, f"the scope's base {base} has no green run of {Path(workflow).name}: "
                               "the push runs its scoped checks", False)
        runs = api.get(f"actions/workflows/{urllib.parse.quote(Path(workflow).name)}/runs",
                       head_sha=head, event="pull_request", per_page=100)["workflow_runs"]
        runs = [run for run in runs if run.get("head_sha") == head and run.get("event") == "pull_request"
                and (run.get("repository") or {}).get("full_name") == repository
                and (run.get("head_repository") or {}).get("full_name") == repository]
        if not runs:
            return Verdict(False, "no pull request run validated " + head, green_base)
        run = max(runs, key=lambda item: (item["updated_at"], item["id"]))
        max_age = float(artifact.input_value("max-age-hours", "6") or "6") * 3600
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            return Verdict(False, f"the latest pull request run did not pass: {run.get('html_url', run['id'])}", green_base)
        if not 0 <= now() - updated_at(run) <= max_age:
            return Verdict(False, f"the latest pull request run is older than the receipt lifetime: {run.get('html_url', run['id'])}",
                           green_base)
        receipt = receipts(run, receipt_name())
        if receipt is None:
            return Verdict(False, f"the pull request run stored no receipt: {run.get('html_url', run['id'])}", green_base)
        expected = {"version": RECEIPT_VERSION, "repository": repository, "workflow": workflow,
                    "run_id": run["id"], "run_attempt": run["run_attempt"], "variables": variables_digest()}
        differs = sorted(key for key, value in expected.items() if receipt.get(key) != value)
        recorded = receipt.get("source") or {}
        if recorded.get("tree") != source["tree"]:
            differs.append("tree")
        if (recorded.get("parents") or [])[1:] != [head]:
            differs.append("head")
        if differs:
            return Verdict(False, "the receipt does not match this push (" + ", ".join(differs) + "): every check runs", green_base)
        passed, skipped = receipt.get("passed"), receipt.get("skipped")
        if not isinstance(passed, list) or not isinstance(skipped, list):
            return Verdict(False, "the receipt does not list its passed and skipped jobs: every check runs", green_base)
        where = f"{run.get('html_url', run['id'])}" + (f" on green base {base}" if base else "")
        if required is None:
            # Unscoped, every job the pull request recorded must have run and passed.
            if skipped:
                return Verdict(False, f"the pull request run did not pass {', '.join(sorted(set(skipped)))}: "
                               f"{where}: every check runs", green_base)
            return Verdict(True, f"tree {source['tree']} passed in {where}", green_base)
        # A job that passed on this tree needs no second run, whatever else
        # the push requires; the rest run.
        remaining = [name for name in required if name not in passed]
        if remaining:
            reusable = [name for name in required if name in passed]
            return Verdict(False, f"tree {source['tree']} passed {', '.join(reusable) or 'none of the required jobs'} in "
                           f"{where}; the push runs {', '.join(remaining)}", green_base, remaining)
        return Verdict(True, f"tree {source['tree']} passed in {where}", green_base, [])
    except (KeyError, TypeError, ValueError, AttributeError, OSError, subprocess.SubprocessError,
            zipfile.BadZipFile, urllib.error.URLError) as error:
        return Verdict(False, f"acceptance evidence unavailable ({type(error).__name__}: {error}): every check runs", green_base)


def main():
    mode = artifact.input_value("mode")
    if mode == "record":
        record(os.environ)
        return
    if mode != "verify":
        raise ValueError("mode must be record or verify")
    verdict = verify(os.environ)
    print(verdict.reason)
    artifact.output("reused", str(verdict.reused).lower())
    artifact.output("reason", verdict.reason.replace("\n", " "))
    artifact.output("green_base", "" if verdict.green_base is None else str(verdict.green_base).lower())
    required = required_jobs()
    remaining = verdict.remaining if verdict.remaining is not None else required
    artifact.output("remaining", "" if remaining is None else json.dumps(remaining))
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"Acceptance: {'reused' if verdict.reused else 'not reused'}, {verdict.reason}\n")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f"acceptance failed: HTTP {error.code} ({error.reason})", file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"acceptance failed: {error}", file=sys.stderr)
        sys.exit(1)
