#!/usr/bin/env python3
"""Reuse a pull request's passing validation for the push that merges the same tree.

record runs in a pull request run once its validation jobs pass, and stores a
receipt naming the tested merge commit's tree. verify runs first in the push
that merges the pull request: when the pushed merge commit carries the same
tree, the same workflow file and the same repository variables, the checks
that already passed need not run again.
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
    """The receipt for this pull request run; raises unless every validation job passed."""
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
    failed = sorted(name for name, job in results.items() if not isinstance(job, dict) or job.get("result") != "success")
    if failed:
        raise ValueError("validation did not pass: " + ", ".join(failed))
    return {"version": RECEIPT_VERSION, "repository": repository, "workflow": workflow_path(env),
            "run_id": int(env["GITHUB_RUN_ID"]), "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]),
            "source": source, "variables": variables_digest(), "jobs": sorted(results)}


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
    print(f"recorded {name} for tree {receipt['source']['tree']} ({', '.join(receipt['jobs'])})")


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


def verify(env, api=None, receipts=fetch_receipt, now=time.time):
    """(reused, reason). Anything short of a matching receipt runs every check."""
    if env.get("GITHUB_EVENT_NAME") != "push":
        return False, "only a push reuses pull request validation"
    try:
        payload = event(env)
        if env.get("GITHUB_REF") != "refs/heads/" + payload["repository"]["default_branch"]:
            return False, "only a push to the default branch reuses pull request validation"
        if env.get("GITHUB_RUN_ATTEMPT") != "1":
            return False, "a rerun executes every check"
        source = commit()
        if (source["sha"] != env["GITHUB_SHA"] or len(source["parents"]) != 2
                or source["parents"][0] != payload.get("before")):
            return False, "the push is not a single merge commit on the previous head"
        head = source["parents"][1]
        repository = env["GITHUB_REPOSITORY"]
        workflow = workflow_path(env)
        api = api or GitHub(env)
        runs = api.get(f"actions/workflows/{urllib.parse.quote(Path(workflow).name)}/runs",
                       head_sha=head, event="pull_request", per_page=100)["workflow_runs"]
        runs = [run for run in runs if run.get("head_sha") == head and run.get("event") == "pull_request"
                and (run.get("repository") or {}).get("full_name") == repository
                and (run.get("head_repository") or {}).get("full_name") == repository]
        if not runs:
            return False, "no pull request run validated " + head
        run = max(runs, key=lambda item: (item["updated_at"], item["id"]))
        max_age = float(artifact.input_value("max-age-hours", "6") or "6") * 3600
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            return False, f"the latest pull request run did not pass: {run.get('html_url', run['id'])}"
        if not 0 <= now() - updated_at(run) <= max_age:
            return False, f"the latest pull request run is older than the receipt lifetime: {run.get('html_url', run['id'])}"
        receipt = receipts(run, receipt_name())
        if receipt is None:
            return False, f"the pull request run stored no receipt: {run.get('html_url', run['id'])}"
        expected = {"version": RECEIPT_VERSION, "repository": repository, "workflow": workflow,
                    "run_id": run["id"], "run_attempt": run["run_attempt"], "variables": variables_digest()}
        differs = sorted(key for key, value in expected.items() if receipt.get(key) != value)
        recorded = receipt.get("source") or {}
        if recorded.get("tree") != source["tree"]:
            differs.append("tree")
        if (recorded.get("parents") or [])[1:] != [head]:
            differs.append("head")
        if differs:
            return False, "the receipt does not match this push (" + ", ".join(differs) + "): every check runs"
        return True, f"tree {source['tree']} passed in {run.get('html_url', run['id'])}"
    except (KeyError, TypeError, ValueError, AttributeError, OSError, subprocess.SubprocessError,
            zipfile.BadZipFile, urllib.error.URLError) as error:
        return False, f"acceptance evidence unavailable ({type(error).__name__}: {error}): every check runs"


def main():
    mode = artifact.input_value("mode")
    if mode == "record":
        record(os.environ)
        return
    if mode != "verify":
        raise ValueError("mode must be record or verify")
    reused, reason = verify(os.environ)
    print(reason)
    artifact.output("reused", str(reused).lower())
    artifact.output("reason", reason.replace("\n", " "))
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"Acceptance: {'reused' if reused else 'not reused'}, {reason}\n")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f"acceptance failed: HTTP {error.code} ({error.reason})", file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"acceptance failed: {error}", file=sys.stderr)
        sys.exit(1)
