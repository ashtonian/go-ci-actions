import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

LIB = Path(__file__).parents[1] / "lib"
sys.path.insert(0, str(LIB))
spec = importlib.util.spec_from_file_location("runner_labels", LIB / "runner_labels.py")
runner_labels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner_labels)

WORKFLOW = """
on:
  workflow_call:
    inputs:
      runner:
        type: string
        default: arc-gone-default
jobs:
  literal:
    runs-on: arc-live
  hosted:
    runs-on: ubuntu-26.04
  flow:
    runs-on: [arc-live, arc-gone-flow]
  block:
    runs-on:
      - arc-live
      - arc-gone-block
  grouped:
    runs-on:
      group: arc
      labels: arc-gone-group
  flowmap:
    runs-on: {group: arc, labels: [arc-live, arc-gone-flowmap]}
  groupmap:
    runs-on: {group: arc}
  flowscalar:
    runs-on: {labels: arc-gone-flowscalar, group: "a, b"}
  quotedmap:
    runs-on: {group: "x, y", labels: "${{ vars.R || 'arc-gone-quotedmap' }}"}
  paren:
    runs-on: ${{ (vars.LARGE && 'arc-gone-paren') || 'arc-live' }}
  fallback:
    runs-on: ${{ vars.RUNNER || 'arc-gone-fallback' }}
  chosen:
    runs-on: ${{ github.event_name == 'push' && 'arc-live' || 'arc-gone-choice' }}
  matrix:
    strategy:
      matrix:
        runner: [arc-live, arc-gone-matrix]
        include:
          - runner: arc-gone-include
    runs-on: ${{ matrix.runner }}
  json:
    strategy:
      matrix:
        os: ${{ fromJSON(vars.MAC == 'on' && '["arc-live","macos-latest"]' || '["arc-gone-json"]') }}
    runs-on: ${{ matrix.os }}
  call:
    uses: ./.github/workflows/reusable.yml
    with:
      runner: arc-gone-call
      lint-runner: ${{ inputs.fast || 'arc-live' }}
      other: arc-not-a-runner
  unchecked:
    runs-on: ${{ inputs.runner }}
"""


class Answer(http.server.BaseHTTPRequestHandler):
    status = 200
    body = {"labels": ["arc-live"]}
    seen = []

    def do_GET(self):
        Answer.seen.append(self.path)
        data = json.dumps(self.body).encode()
        self.send_response(self.status)
        if 300 <= self.status < 400:
            self.send_header("Location", "/elsewhere")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class Workflows(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "ci.yml").write_text(WORKFLOW)

    def tearDown(self):
        self.directory.cleanup()

    def run_main(self, **inputs):
        env = {"GITHUB_REPOSITORY": "owner/repo", "INPUT_WORKFLOWS": str(self.root)}
        env.update({"INPUT_" + key.upper(): value for key, value in inputs.items()})
        out = io.StringIO()
        with patch("sys.stdout", out), patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GITHUB_OUTPUT", None)
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            code = runner_labels.main(env)
        return code, out.getvalue()


class LabelTests(Workflows):
    def test_reads_every_place_a_workflow_names_a_runner(self):
        found = {label for _, label, _ in runner_labels.workflow_labels(WORKFLOW)}
        gone = {label for label in found if label.startswith("arc-gone")}
        self.assertEqual(gone, {"arc-gone-default", "arc-gone-flow", "arc-gone-block", "arc-gone-group",
                                "arc-gone-fallback", "arc-gone-choice", "arc-gone-matrix", "arc-gone-include",
                                "arc-gone-json", "arc-gone-call", "arc-gone-flowmap", "arc-gone-flowscalar",
                                "arc-gone-paren", "arc-gone-quotedmap"})
        self.assertNotIn("push", found, "a comparison operand is no label")
        self.assertFalse(any(label.startswith(("{", "group")) for label in found), "a flow mapping is no label")
        self.assertNotIn("arc-not-a-runner", found, "only runner inputs name runners")
        self.assertIn("macos-latest", found)

    def test_fails_on_each_label_no_runner_carries(self):
        file = self.root / "labels.json"
        file.write_text(json.dumps({"labels": ["arc-live"]}))
        code, out = self.run_main(labels_file=str(file))
        self.assertEqual(code, 1)
        self.assertEqual(out.count("::error"), 14)
        self.assertIn("names runner label `arc-gone-matrix`", out)
        self.assertNotIn("`ubuntu-26.04`", out)
        self.assertNotIn("`macos-latest`", out)

    def test_allow_accepts_further_runners(self):
        file = self.root / "labels.json"
        file.write_text(json.dumps(["arc-live"]))
        code, _ = self.run_main(labels_file=str(file), allow="arc-gone-*\n")
        self.assertEqual(code, 0)

    def test_a_per_scope_file_gives_the_repository_its_own_and_its_owners_labels(self):
        index = {"owner": ["arc-live"], "owner/repo": ["arc-gone-flow"], "owner/other": ["arc-gone-block"]}
        self.assertEqual(runner_labels.scoped(index, "owner/repo"), ["arc-live", "arc-gone-flow"])


class ServiceTests(Workflows):
    def setUp(self):
        super().setUp()
        Answer.status, Answer.body, Answer.seen = 200, {"labels": ["arc-live"]}, []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Answer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def test_asks_the_service_for_the_repositorys_labels(self):
        code, out = self.run_main(endpoint=self.endpoint)
        self.assertEqual(code, 1)
        self.assertEqual(Answer.seen, ["/v1/labels?repository=owner%2Frepo"])
        self.assertIn("arc-gone-call", out)

    def test_passes_with_a_warning_when_the_service_has_no_answer(self):
        for status, body in [(503, {"error": "no fresh view"}), (200, {"labels": "arc-live"}), (200, [])]:
            Answer.status, Answer.body = status, body
            with self.subTest(status=status, body=body):
                code, out = self.run_main(endpoint=self.endpoint)
                self.assertEqual(code, 0)
                self.assertIn("::warning::", out)
                self.assertNotIn("::error", out)

    def test_follows_no_redirect(self):
        Answer.status = 302
        code, out = self.run_main(endpoint=self.endpoint)
        self.assertEqual(code, 0)
        self.assertIn("HTTP 302", out)
        self.assertEqual(len(Answer.seen), 1, "the redirect target is never requested")

    def test_passes_with_a_warning_when_unreachable_or_unconfigured(self):
        self.server.shutdown()
        self.server.server_close()
        code, out = self.run_main(endpoint=self.endpoint)
        self.assertEqual((code, "::warning::" in out), (0, True))
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CI_RUNNER_LABELS_URL", None)
            code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("no runner label list", out)
        # tearDown shuts the server down again; give it a fresh one to close.
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Answer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def test_the_runner_bundle_names_the_service_for_job_containers(self):
        bundle = self.root / "tool" / "go-ci-cache" / "v1"
        bundle.mkdir(parents=True)
        (bundle / "config.json").write_text(json.dumps({"version": 1, "runnerLabelsURL": self.endpoint}))
        with patch("sys.stdout", io.StringIO()):
            code = runner_labels.main({"GITHUB_REPOSITORY": "owner/repo", "INPUT_WORKFLOWS": str(self.root),
                                       "RUNNER_TOOL_CACHE": str(self.root / "tool")})
        self.assertEqual(code, 1)
        self.assertEqual(len(Answer.seen), 1)

    def test_a_broken_runner_setting_skips_and_a_broken_input_fails(self):
        for url in ["ftp://host", "http://user:secret@host", "http://host/#frag", "http://a,http://b"]:
            with self.subTest(url=url):
                with patch("sys.stdout", io.StringIO()) as stdout:
                    code = runner_labels.main({"GITHUB_REPOSITORY": "owner/repo", "INPUT_WORKFLOWS": str(self.root),
                                               "CI_RUNNER_LABELS_URL": url})
                self.assertEqual(code, 0)
                self.assertIn("runner label check skipped", stdout.getvalue())
                with self.assertRaises(ValueError):
                    self.run_main(endpoint=url)

    def test_the_runner_variable_names_the_service(self):
        with patch("sys.stdout", io.StringIO()):
            code = runner_labels.main({"GITHUB_REPOSITORY": "owner/repo", "INPUT_WORKFLOWS": str(self.root),
                                       "CI_RUNNER_LABELS_URL": self.endpoint})
        self.assertEqual(code, 1)
        self.assertEqual(len(Answer.seen), 1)


if __name__ == "__main__":
    unittest.main()
