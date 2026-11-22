"""A workflow file's outline: enough YAML for the keys the actions read.

Each mapping entry and sequence item is a Node with the line it sits on, so
callers can point at it. Only the standard library: the actions run on any
runner's python3.
"""

import json
import re

KEY = re.compile(r"""^(?P<key>"[^"]*"|'[^']*'|[^\s#"'][^:#]*?)\s*:(?:\s+(?P<rest>.*))?$""")
BLOCK_SCALAR = re.compile(r"^[|>][-+0-9]*$")
EXPRESSION = "${{"


class Node:
    """One mapping entry (`key` set) or sequence item (`key` None) and what it holds.

    value is the scalar unquoted; raw is it as written, without its comment.
    """

    def __init__(self, line, indent, key, raw):
        self.line = line
        self.indent = indent
        self.key = key
        self.raw = raw
        self.value = unquote(raw)
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


def scalar(raw):
    """A one-line scalar's value as YAML reads it, or None for anything else.

    Plain scalars are taken as written; a double-quoted one is decoded with its
    escapes and a single-quoted one with its doubled quotes. A block scalar, a
    flow collection, an alias or a tag is None: the outline does not read it.
    """
    if not raw or BLOCK_SCALAR.match(raw) or raw[0] in "[{*&!|>":
        return None
    if raw[0] == '"':
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, str) else None
    if raw[0] == "'":
        if len(raw) < 2 or raw[-1] != "'":
            return None
        return raw[1:-1].replace("''", "'")
    return raw


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
                item.raw, item.value = value, unquote(value)
                if BLOCK_SCALAR.match(value):
                    scalar_indent = indent
                continue
            indent += len(body) - len(content)
            body = content
        m = KEY.match(body)
        if not m:
            continue
        value = split_comment(m.group("rest") or "")
        attach(Node(n, indent, unquote(m.group("key")), value))
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


class NamePattern:
    """The names GitHub shows for one job's runs in a workflow run's job list.

    A literal name (the job ID when `name` is unset) shows as itself, with its
    matrix values appended, `name (a, b)`, and a job that calls a reusable
    workflow shows each called job as `name / job`. A name holding an
    expression is evaluated, so only its literal prefix is known: every name
    starting with it may be the job's. A name the outline cannot read could be
    anything.
    """

    def __init__(self, literal=None, prefix=None):
        self.literal = literal
        self.prefix = prefix

    def matches(self, name):
        if self.literal is not None:
            return name == self.literal or name.startswith(self.literal + " (") or name.startswith(self.literal + " / ")
        return name.startswith(self.prefix)


def job_name_patterns(text):
    """{job ID: NamePattern} for every job the workflow's top-level jobs mapping defines."""
    jobs = parse(text).get("jobs")
    patterns = {}
    for job in jobs.children if jobs is not None else []:
        if job.key is None:
            continue
        node = job.get("name")
        if node is None:
            patterns[job.key] = NamePattern(literal=job.key)
            continue
        name = scalar(node.raw)
        if name is None:
            patterns[job.key] = NamePattern(prefix="")
        elif EXPRESSION in name:
            patterns[job.key] = NamePattern(prefix=name[:name.index(EXPRESSION)])
        else:
            patterns[job.key] = NamePattern(literal=name)
    return patterns


EMPTY = ("", "{}", "null", "~")


def dispatch_takes_inputs(text):
    """Whether the workflow's workflow_dispatch trigger declares inputs.

    True also when the workflow has no such trigger or the outline cannot
    tell: a caller treats an unknown as inputs that may narrow the run.
    """
    trigger = parse(text).get("on")
    if trigger is None:
        return True
    if not trigger.children:
        # `on: workflow_dispatch` or `on: [push, workflow_dispatch]`.
        events = flow_list(trigger.value) if trigger.value.startswith("[") else [trigger.value]
        return "workflow_dispatch" not in events
    if any(item.value == "workflow_dispatch" for item in trigger.items()):
        return False
    dispatch = trigger.get("workflow_dispatch")
    if dispatch is None or dispatch.raw not in EMPTY:
        return True
    inputs = dispatch.get("inputs")
    return inputs is not None and (bool(inputs.children) or inputs.raw not in EMPTY)
