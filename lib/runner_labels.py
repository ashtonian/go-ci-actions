#!/usr/bin/env python3
"""Fail a workflow that names a self-hosted runner label no runner carries.

GitHub never assigns a job whose runs-on names a label no registered runner
carries. The job waits until it is cancelled, and its run holds its
concurrency group meanwhile. This reads every workflow's runs-on, the
`runner`/`*-runner` inputs of reusable workflow calls and the defaults of such
inputs, and checks each label against the labels the repository's runners
carry. Those come from labels-file, or from the runner label service: the
endpoint input, else the runner's CI_RUNNER_LABELS_URL, else runnerLabelsURL
in the runner bundle ($RUNNER_TOOL_CACHE/go-ci-cache/v1/config.json, which
job containers see too).

Only a definitive answer fails: when the service cannot be reached, or no list
is configured, the step warns and passes.
"""

import fnmatch
import http.client
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse

# GitHub-hosted images: valid wherever the account may use hosted runners.
HOSTED = ("ubuntu-*", "windows-*", "macos-*")
CONNECT_TIMEOUT = 3
READ_TIMEOUT = 10
MAX_RESPONSE = 1024 * 1024
MAX_BUNDLE = 64 * 1024
REPOSITORY = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}")

# A workflow outline parser:
# enough YAML for the keys this reads, with the line each sits on, and no
# dependency outside the standard library.
KEY = re.compile(r"""^(?P<key>"[^"]*"|'[^']*'|[^\s#"'][^:#]*?)\s*:(?:\s+(?P<rest>.*))?$""")
BLOCK_SCALAR = re.compile(r"^[|>][-+0-9]*$")
QUOTED = re.compile(r"'((?:[^']|'')*)'")
MATRIX = re.compile(r"\bmatrix\.([A-Za-z_][A-Za-z0-9_-]*)")
RESULT_BEFORE = ("${{", "||", "&&", "(")
RESULT_AFTER = ("}}", "||", "&&", ")")


class Unavailable(Exception):
    """No list of labels to check against."""


class Node:
    """One mapping entry (`key` set) or sequence item (`key` None) and what it holds."""

    def __init__(self, line, indent, key, value):
        self.line = line
        self.indent = indent
        self.key = key
        self.value = value
        self.children = []

    def get(self, key):
        return next((c for c in self.children if c.key == key), None)

    def items(self):
        return [c for c in self.children if c.key is None]


def split_comment(text):
    """Return a line's text without its comment, ignoring a `#` inside quotes."""
    quote = None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] in " \t"):
            return text[:i].rstrip()
    return text.rstrip()


def unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse(text):
    """Parse the YAML outline into a root Node."""
    root = Node(0, -1, None, "")
    stack = [root]
    scalar_indent = None

    def attach(node):
        while True:
            top = stack[-1]
            if top.indent < node.indent:
                break
            # A sequence may sit at its key's own indent (`steps:` then `- run: x`).
            if top.indent == node.indent and node.key is None and top.key is not None and not top.value:
                break
            stack.pop()
        stack[-1].children.append(node)
        stack.append(node)

    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if scalar_indent is not None:
            if indent > scalar_indent:
                continue
            scalar_indent = None
        body = raw.strip()
        if body.startswith("#"):
            continue
        if body == "-" or body.startswith("- "):
            content = body[1:].lstrip()
            item = Node(n, indent, None, "")
            attach(item)
            if not content:
                continue
            if not KEY.match(content):
                value = split_comment(content)
                item.value = unquote(value)
                if BLOCK_SCALAR.match(value):
                    scalar_indent = indent
                continue
            indent += len(body) - len(content)
            body = content
        m = KEY.match(body)
        if not m:
            continue
        value = split_comment(m.group("rest") or "")
        attach(Node(n, indent, unquote(m.group("key")), unquote(value)))
        if BLOCK_SCALAR.match(value):
            scalar_indent = indent
    return root


def flow_list(value):
    return [unquote(part.strip()) for part in value.strip("[]").split(",") if part.strip()]


def flow_entries(value):
    """{key: value} of a one-line flow mapping (`{group: g, labels: [a, b]}`), split at the commas
    outside brackets and quotes."""
    entries, depth, start, quote, body = {}, 0, 0, None, value.strip()[1:-1]
    parts = []
    for i, ch in enumerate(body):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(body[start:i])
            start = i + 1
    parts.append(body[start:])
    for part in parts:
        key, _, item = part.partition(":")
        if key.strip():
            entries[unquote(key.strip())] = item.strip()
    return entries


def expression_labels(expression):
    """The labels an expression can evaluate to, as far as its text says.

    A string literal counts where it is a result (`vars.R || 'arc-x'`,
    `c && 'arc-a' || 'arc-b'`), not an operand (`event_name == 'push'`). A
    literal JSON array (`fromJSON('["a","b"]')`) counts item by item."""
    found = []
    for match in QUOTED.finditer(expression):
        literal = match.group(1).replace("''", "'")
        if literal.startswith("["):
            try:
                items = json.loads(literal)
            except ValueError:
                continue
            found += [item for item in items if isinstance(item, str)] if isinstance(items, list) else []
            continue
        before = expression[:match.start()].rstrip()
        after = expression[match.end():].lstrip()
        if before.endswith(RESULT_BEFORE) and after.startswith(RESULT_AFTER):
            found.append(literal)
    return found


def node_labels(node, matrix=None):
    """[(line, label)] a runs-on-like node names: a scalar, a list, `labels:`, or an expression."""
    if node.value.startswith("${{"):
        found = [(node.line, label) for label in expression_labels(node.value)]
        for key in MATRIX.findall(node.value):
            found += matrix_labels(matrix, key)
        return found
    if node.value.startswith("["):
        return [(node.line, label) for label in flow_list(node.value)]
    if node.value.startswith("{"):
        # A runner group alone (`{group: g}`) names no label to check.
        labels = unquote(flow_entries(node.value).get("labels", ""))
        if not labels:
            return []
        if labels.startswith("${{"):
            return [(node.line, label) for label in expression_labels(labels)]
        return [(node.line, label) for label in (flow_list(labels) if labels.startswith("[") else [unquote(labels)])]
    if node.value:
        return [(node.line, node.value)]
    labels = node.get("labels")
    if labels is not None:
        # A runner group alone (`group:`) names no label to check.
        return node_labels(labels, matrix)
    found = []
    for item in node.items():
        found += node_labels(item, matrix)
    return found


def matrix_labels(matrix, key):
    """[(line, label)] the strategy matrix gives key: its values and its include entries'."""
    if matrix is None:
        return []
    found = []
    values = matrix.get(key)
    if values is not None:
        found += node_labels(values)
    include = matrix.get("include")
    for entry in include.items() if include is not None else []:
        value = entry.get(key)
        if value is not None:
            found += node_labels(value)
    return found


def runner_input(name):
    return name == "runner" or name.endswith("-runner")


def workflow_labels(text):
    """[(line, label, where)] every runner label the workflow names."""
    root = parse(text)
    found = []
    trigger = root.get("on")
    call = trigger.get("workflow_call") if trigger is not None else None
    inputs = call.get("inputs") if call is not None else None
    for node in inputs.children if inputs is not None else []:
        default = node.get("default")
        if runner_input(node.key) and default is not None:
            found += [(line, label, f"input `{node.key}`'s default") for line, label in node_labels(default)]
    jobs = root.get("jobs")
    for job in jobs.children if jobs is not None else []:
        strategy = job.get("strategy")
        matrix = strategy.get("matrix") if strategy is not None else None
        if job.get("uses") is not None:
            with_ = job.get("with")
            for node in with_.children if with_ is not None else []:
                if runner_input(node.key):
                    found += [(line, label, f"job `{job.key}` input `{node.key}`")
                              for line, label in node_labels(node, matrix)]
            continue
        runs_on = job.get("runs-on")
        if runs_on is not None:
            found += [(line, label, f"job `{job.key}`") for line, label in node_labels(runs_on, matrix)]
    return found


def scoped(data, repository):
    """The label list in a labels file: a list, {"labels": [...]}, or {scope: [...]} per scope."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("labels"), list):
        return data["labels"]
    if isinstance(data, dict):
        owner = repository.split("/", 1)[0]
        return [*data.get(owner, []), *data.get(repository, [])]
    raise ValueError("labels-file must hold a list, {\"labels\": [...]}, or {scope: [...]}")


def service_url(name, value):
    """value as an HTTP(S) origin without credentials or a fragment, as the setup action takes runner URLs."""
    if not isinstance(value, str) or re.search(r"[\s,|]", value):
        raise ValueError(f"{name} must be a single HTTP(S) URL")
    url = urllib.parse.urlsplit(value)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError(f"{name} must be HTTP(S) without credentials or a fragment")
    return value


def bundle_url(env):
    """runnerLabelsURL from the runner-owned bundle under the tool cache, or empty."""
    cache = env.get("RUNNER_TOOL_CACHE", "")
    if not cache:
        return ""
    path = Path(cache) / "go-ci-cache" / "v1" / "config.json"
    if not path.is_file() or path.stat().st_size > MAX_BUNDLE:
        return ""
    config = json.loads(path.read_text(encoding="utf-8"))
    return config.get("runnerLabelsURL", "") if isinstance(config, dict) and config.get("version") == 1 else ""


def fetch(endpoint, repository):
    # http.client follows no redirect: a 3xx is an answer other than 200.
    url = urllib.parse.urlsplit(endpoint.rstrip("/"))
    target = url.path + "/v1/labels?" + urllib.parse.urlencode({"repository": repository})
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=CONNECT_TIMEOUT)
    try:
        connection.connect()
        connection.sock.settimeout(READ_TIMEOUT)
        connection.request("GET", target, headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE + 1)
    except (OSError, http.client.HTTPException) as error:
        raise Unavailable(f"the runner label service did not answer ({error})") from error
    finally:
        connection.close()
    if response.status != 200:
        raise Unavailable(f"the runner label service answered HTTP {response.status}")
    if len(body) > MAX_RESPONSE:
        raise Unavailable("the runner label service's answer is oversized")
    try:
        labels = json.loads(body)["labels"]
    except (ValueError, KeyError, TypeError) as error:
        raise Unavailable(f"the runner label service's answer is malformed ({error})") from error
    if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
        raise Unavailable("the runner label service's answer is malformed")
    return labels


def runner_labels(env, repository):
    path = env.get("INPUT_LABELS_FILE", "").strip()
    if path:
        return scoped(json.loads(Path(path).read_text(encoding="utf-8")), repository)
    endpoint = env.get("INPUT_ENDPOINT", "").strip()
    if endpoint:
        return fetch(service_url("endpoint", endpoint), repository)
    # A runner's own setting that is broken is the runner's problem, not this
    # change's: it skips the check like a missing one.
    try:
        endpoint = env.get("CI_RUNNER_LABELS_URL", "").strip() or bundle_url(env)
        if endpoint:
            return fetch(service_url("the runner's label service URL", endpoint), repository)
    except (ValueError, OSError) as error:
        raise Unavailable(f"the runner's label service setting is unusable ({error})") from error
    raise Unavailable("no runner label list: the runner names no label service (CI_RUNNER_LABELS_URL or "
                      "runnerLabelsURL in its bundle), and neither endpoint nor labels-file is given")


def problems(workflows, labels, allow):
    """[(path, line, message)] for each label neither carried nor allowed."""
    valid = set(labels)
    patterns = (*HOSTED, *allow)
    found = []
    for path in workflows:
        for line, label, where in workflow_labels(path.read_text(encoding="utf-8")):
            if label in valid or any(fnmatch.fnmatchcase(label, pattern) for pattern in patterns):
                continue
            found.append((path, line, f"{where} names runner label `{label}`, which no runner of this "
                                      "repository carries: the job would wait until cancelled"))
    return found


def lines(value):
    return [line.strip() for line in value.splitlines() if line.strip() and not line.strip().startswith("#")]


def output(name, value):
    if target := os.environ.get("GITHUB_OUTPUT"):
        with open(target, "a", encoding="utf-8") as stream:
            stream.write(f"{name}={value}\n")


def summary(text):
    if target := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(target, "a", encoding="utf-8") as stream:
            stream.write(text + "\n")


def main(env=os.environ):
    repository = env.get("INPUT_REPOSITORY", "").strip() or env.get("GITHUB_REPOSITORY", "")
    if not REPOSITORY.fullmatch(repository):
        raise ValueError(f"repository {repository!r} is not <owner>/<name>")
    directory = Path(env.get("INPUT_WORKFLOWS", "").strip() or ".github/workflows")
    workflows = sorted(p for p in directory.glob("*") if p.suffix in (".yml", ".yaml") and p.is_file())
    try:
        labels = runner_labels(env, repository)
    except Unavailable as error:
        print(f"::warning::runner label check skipped: {error}")
        summary(f"Runner labels: check skipped, {error}.")
        output("checked", "false")
        return 0
    found = problems(workflows, labels, lines(env.get("INPUT_ALLOW", "")))
    for path, line, message in found:
        print(f"::error file={path},line={line}::{message}")
    output("checked", "true")
    summary(f"Runner labels: {len(workflows)} workflow(s) checked against {len(labels)} label(s) for "
            f"{repository}; {len(found)} problem(s).")
    print(f"runner labels: {len(workflows)} workflow(s), {len(labels)} label(s), {len(found)} problem(s)")
    return 1 if found else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(f"runner-labels failed: {error}", file=sys.stderr)
        sys.exit(1)
