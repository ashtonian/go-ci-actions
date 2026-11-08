#!/usr/bin/env python3
"""Run-scoped CI artifacts on an OIDC-authenticated SeaweedFS S3 endpoint."""

import argparse
import base64
import fnmatch
import glob
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


MAX_DOCUMENT = 16 * 1024 * 1024
MAX_EXTRACTED = 50 * 1024**3
AUDIENCE = "ci-artifacts"


def positive(value, label):
    if not re.fullmatch(r"[1-9][0-9]*", str(value)):
        raise ValueError(f"{label} must be a positive integer")
    return str(value)


def input_value(name, default=""):
    return os.environ.get("INPUT_" + name.replace("-", "_").upper(), default)


def boolean(value):
    if str(value).lower() not in ("true", "false"):
        raise ValueError("boolean input must be true or false")
    return str(value).lower() == "true"


def output(name, value):
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as stream:
            stream.write(f"{name}={value}\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # An authentication credential must never follow an endpoint redirect.
        return None


class Store:
    def __init__(self, endpoint=None, bucket=None):
        self.endpoint = (endpoint or os.environ.get("CI_ARTIFACT_ENDPOINT", "")).rstrip("/")
        url = urllib.parse.urlsplit(self.endpoint)
        internal = (url.hostname or "").endswith(".svc.cluster.local")
        if (url.scheme != "https" and not (url.scheme == "http" and internal)) or not url.hostname:
            raise ValueError("CI_ARTIFACT_ENDPOINT must be HTTPS (cluster service HTTP is allowed)")
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("artifact endpoint must be an origin without credentials or a path")
        self.bucket = bucket or os.environ.get("CI_ARTIFACT_BUCKET", "ci-artifacts")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.bucket):
            raise ValueError("invalid artifact bucket")
        self.repository_id = positive(os.environ.get("GITHUB_REPOSITORY_ID", ""), "repository ID")
        self.run_id = positive(os.environ.get("GITHUB_RUN_ID", ""), "run ID")
        self.attempt = positive(os.environ.get("GITHUB_RUN_ATTEMPT", ""), "run attempt")
        self.opener = urllib.request.build_opener(NoRedirect)
        self.token = None
        self.refresh_at = 0

    def credential(self):
        if self.token and time.time() < self.refresh_at:
            return self.token
        url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
        request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
        if not url.startswith("https://") or not request_token:
            raise ValueError("artifact access requires GitHub Actions permissions: id-token: write")
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"audience": AUDIENCE})
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + request_token})
        with self.opener.open(req, timeout=30) as response:
            token = json.loads(response.read(MAX_DOCUMENT + 1))["value"]
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
        for key, value in (("repository_id", self.repository_id), ("run_id", self.run_id), ("run_attempt", self.attempt)):
            if str(claims.get(key)) != value:
                raise ValueError(f"OIDC {key} does not match this workflow")
        # Only the server verifies the signature. These local checks catch caller
        # configuration errors; they are never an authorization decision.
        if claims.get("aud") != AUDIENCE or claims.get("exp", 0) <= time.time() + 30:
            raise ValueError("OIDC token has the wrong audience or is expired")
        print("::add-mask::" + token, file=sys.stderr)
        self.token = token
        self.refresh_at = min(time.time() + 180, claims["exp"] - 30)
        return token

    def request(self, method, key="", *, query=None, body=None, headers=None, target=None, max_bytes=MAX_EXTRACTED):
        url = self.endpoint + "/" + self.bucket + "/" + urllib.parse.quote(key, safe="/")
        if query:
            url += "?" + urllib.parse.urlencode(query)
        for attempt in range(3):
            auth = {"Authorization": "Bearer " + self.credential(), **(headers or {})}
            stream = None
            try:
                data = body
                if isinstance(body, Path):
                    stream = body.open("rb")
                    data = stream
                    auth["Content-Length"] = str(body.stat().st_size)
                req = urllib.request.Request(url, data=data, headers=auth, method=method)
                with self.opener.open(req, timeout=120) as response:
                    if target:
                        with Path(target).open("wb") as dest:
                            size = 0
                            while chunk := response.read(1024 * 1024):
                                size += len(chunk)
                                if size > max_bytes:
                                    raise ValueError("artifact transfer exceeds its byte limit")
                                dest.write(chunk)
                        return b"", dict(response.headers)
                    result = response.read(MAX_DOCUMENT + 1)
                    if len(result) > MAX_DOCUMENT:
                        raise ValueError("artifact response exceeds document limit")
                    return result, dict(response.headers)
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise
            except (TimeoutError, urllib.error.URLError, ConnectionError):
                if attempt == 2:
                    raise
            finally:
                if stream:
                    stream.close()
            time.sleep(2**attempt)
        raise RuntimeError("artifact request exhausted retries")

    def put(self, key, content, digest, overwrite=False):
        headers = {"Content-Type": "application/zip" if isinstance(content, Path) else "application/json",
                   "x-amz-meta-sha256": digest}
        if not overwrite:
            headers["If-None-Match"] = "*"
        try:
            self.request("PUT", key, body=content, headers=headers)
        except urllib.error.HTTPError as exc:
            if exc.code != 412 or overwrite:
                raise
            _, existing = self.request("HEAD", key)
            if next((v for k, v in existing.items() if k.lower() == "x-amz-meta-sha256"), None) != digest:
                raise ValueError("artifact name already exists with different contents; use a unique name") from exc

    def manifests(self, run_id=None, attempt=None):
        run_id = positive(run_id or self.run_id, "run ID")
        prefix = f"metadata/{self.repository_id}/{run_id}/"
        query = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        found = {}
        count = 0
        while True:
            document, _ = self.request("GET", query=query)
            root = ET.fromstring(document)
            for row in root.findall("{*}Contents"):
                key = row.findtext("{*}Key", "")
                if not key.startswith(prefix) or not key.endswith(".json"):
                    raise ValueError("artifact listing escaped the requested run")
                count += 1
                if count > 10000:
                    raise ValueError("artifact listing exceeds 10000 manifests")
                content, _ = self.request("GET", key)
                item = json.loads(content)
                validate_manifest(item, self.repository_id, run_id)
                if key != manifest_key(item):
                    raise ValueError("artifact manifest identity differs from its key")
                if item["expires_at"] <= time.time() or (attempt and int(item["run_attempt"]) > int(attempt)):
                    continue
                old = found.get(item["name"])
                if not old or int(old["run_attempt"]) < int(item["run_attempt"]):
                    found[item["name"]] = item
            if root.findtext("{*}IsTruncated") != "true":
                break
            token = root.findtext("{*}NextContinuationToken")
            if not token or query.get("continuation-token") == token:
                raise ValueError("artifact listing has invalid continuation")
            query["continuation-token"] = token
        return sorted(found.values(), key=lambda item: item["name"])


def name_hash(name):
    if not name or len(name.encode()) > 255 or any(ord(c) < 32 for c in name) or re.search(r'[\\/:<>"|?*]', name) or name in (".", ".."):
        raise ValueError("artifact name must be a safe single path component of at most 255 bytes")
    return hashlib.sha256(name.encode()).hexdigest()


def manifest_key(item):
    return f'metadata/{item["repository_id"]}/{item["run_id"]}/{item["run_attempt"]}/{name_hash(item["name"])}.json'


def data_key(item):
    return f'data/{item["retention_days"]}d/{item["repository_id"]}/{item["run_id"]}/{item["run_attempt"]}/{name_hash(item["name"])}/{item["sha256"]}.zip'


def validate_manifest(item, repository_id, run_id):
    if item.get("version") != 1 or item.get("repository_id") != repository_id or item.get("run_id") != run_id:
        raise ValueError("artifact manifest belongs to another repository or run")
    positive(item["run_attempt"], "run attempt")
    name_hash(item["name"])
    if not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) or not 1 <= item["retention_days"] <= 90:
        raise ValueError("invalid artifact digest or retention")
    if not isinstance(item["size"], int) or item["size"] < 0 or not isinstance(item["expires_at"], (int, float)):
        raise ValueError("invalid artifact size or expiry")
    if item["key"] != data_key(item):
        raise ValueError("artifact data key differs from its identity")


def select_files(patterns, hidden=False):
    includes, excludes = [], []
    for line in patterns.splitlines():
        line = line.strip()
        if line:
            (excludes if line.startswith("!") else includes).append(os.path.abspath(os.path.expanduser(line.lstrip("!"))))
    if not includes:
        raise ValueError("artifact path is required")
    roots, files = [], set()
    for pattern in includes:
        wildcard = re.search(r"[*?[]", pattern)
        root = Path(pattern[:wildcard.start()].rsplit(os.sep, 1)[0]) if wildcard else Path(pattern)
        if not wildcard and not root.is_dir():
            root = root.parent
        if root.is_symlink():
            raise ValueError("artifact search root is a symlink")
        roots.append(str(root))
        for match in glob.glob(pattern, recursive=True, include_hidden=hidden):
            path = Path(match)
            candidates = path.rglob("*") if path.is_dir() and not path.is_symlink() else [path]
            for file in candidates:
                if file.is_symlink() or not file.is_file():
                    continue
                if not hidden and any(part.startswith(".") for part in file.relative_to(root).parts):
                    continue
                if any(fnmatch.fnmatch(str(file), exclude) or str(file).startswith(exclude.rstrip("/") + "/") for exclude in excludes):
                    continue
                if not file.resolve().is_relative_to(root.resolve()):
                    raise ValueError("artifact path traverses a symlink outside its search root")
                files.add(file)
    return Path(os.path.commonpath(roots)), sorted(files)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def upload(store, name, patterns, retention=90, hidden=False, compression=6, overwrite=False, missing="warn"):
    name_hash(name)
    if not 1 <= retention <= 90 or not 0 <= compression <= 9 or missing not in ("warn", "error", "ignore"):
        raise ValueError("invalid retention-days, compression-level, or if-no-files-found")
    root, files = select_files(patterns, hidden)
    if not files:
        if missing == "error":
            raise ValueError("no files found for artifact")
        if missing == "warn":
            print("::warning::No files found for artifact", file=sys.stderr)
        return None
    if sum(file.stat().st_size for file in files) > MAX_EXTRACTED:
        raise ValueError("artifact contents exceed 50 GiB")
    with tempfile.TemporaryDirectory(prefix="ci-artifact-") as directory:
        archive = Path(directory) / "artifact.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=compression, strict_timestamps=False) as target:
            for file in files:
                target.write(file, file.relative_to(root).as_posix())
        if archive.stat().st_size > MAX_EXTRACTED:
            raise ValueError("artifact archive exceeds 50 GiB")
        digest = sha256(archive)
        item = {"version": 1, "name": name, "repository_id": store.repository_id,
                "repository": os.environ.get("GITHUB_REPOSITORY", ""), "run_id": store.run_id,
                "run_attempt": store.attempt, "source_sha": os.environ.get("GITHUB_SHA", ""),
                "retention_days": retention, "sha256": digest, "size": archive.stat().st_size,
                "expires_at": int(time.time()) + retention * 86400}
        item["key"] = data_key(item)
        store.put(item["key"], archive, digest)
        manifest = json.dumps(item, sort_keys=True).encode()
        store.put(manifest_key(item), manifest, hashlib.sha256(manifest).hexdigest(), overwrite)
    output("artifact-id", manifest_key(item))
    output("artifact-digest", digest)
    output("artifact-url", f"s3://{store.bucket}/{item['key']}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"\nArtifact `{name.replace('`', '')}`: `{item['size']}` bytes, {retention} days.\n"
                         f"\n` s3://{store.bucket}/{item['key']} `\n\nSHA-256: `{digest}`. Download with the shared `download-artifact` action.\n")
    return item


def extract(archive, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if sum(item.file_size for item in entries) > MAX_EXTRACTED:
            raise ValueError("artifact extraction exceeds 50 GiB")
        for item in entries:
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if path.is_absolute() or ".." in path.parts or "\\" in item.filename or ":" in item.filename or stat.S_ISLNK(mode):
                raise ValueError("unsafe archive member")
            target = destination.joinpath(*path.parts)
            if not target.resolve().is_relative_to(destination):
                raise ValueError("archive destination traverses a symlink")
        for item in entries:
            target = destination / item.filename
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(item) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)


def download(store, destination, name="", pattern="", run_id=None, attempt=None, merge=False, archive_only=False, max_bytes=MAX_EXTRACTED):
    if not 0 < max_bytes <= MAX_EXTRACTED:
        raise ValueError("download byte limit must be positive and at most 50 GiB")
    found = store.manifests(run_id, attempt)
    matches = [item for item in found if (not name or item["name"] == name) and (not pattern or fnmatch.fnmatchcase(item["name"], pattern))]
    if name and not matches:
        raise ValueError("named artifact was not found or has expired")
    if archive_only and len(matches) != 1:
        raise ValueError("archive download requires exactly one named artifact")
    for item in matches:
        if item["size"] > max_bytes:
            raise ValueError("artifact exceeds download byte limit")
        with tempfile.TemporaryDirectory(prefix="ci-artifact-") as directory:
            archive = Path(directory) / "artifact.zip"
            store.request("GET", item["key"], target=archive, max_bytes=max_bytes)
            if archive.stat().st_size != item["size"] or sha256(archive) != item["sha256"]:
                raise ValueError("artifact archive failed size/SHA-256 verification")
            if archive_only:
                shutil.copyfile(archive, destination)
            else:
                target = Path(destination) if name or merge else Path(destination) / item["name"]
                extract(archive, target)
    output("download-path", str(Path(destination).resolve()))
    return matches


def setup():
    endpoint = input_value("endpoint") or os.environ.get("CI_ARTIFACT_ENDPOINT", "")
    bucket = input_value("bucket", "ci-artifacts")
    if not endpoint:
        raise ValueError("set the CI_ARTIFACT_ENDPOINT repository variable or runner environment")
    for key, value in (("CI_ARTIFACT_ENDPOINT", endpoint), ("CI_ARTIFACT_BUCKET", bucket), ("CI_ARTIFACT_TOOL", str(Path(__file__).resolve()))):
        if "\n" in value or "\r" in value:
            raise ValueError("artifact configuration contains a newline")
        os.environ[key] = value
        if os.environ.get("GITHUB_ENV"):
            with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
                stream.write(f"{key}={value}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup", "upload", "download", "list", "action-upload", "action-download"])
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt")
    parser.add_argument("--name", default="")
    parser.add_argument("--pattern", default="")
    parser.add_argument("--path", default=".")
    parser.add_argument("--archive", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=MAX_EXTRACTED)
    args = parser.parse_args()
    if args.command.startswith("action-") or args.command == "setup":
        setup()
    if args.command == "setup":
        return
    store = Store()
    if args.command in ("upload", "action-upload"):
        retention = int(input_value("retention-days", "0") or "0")
        if retention == 0:
            retention = min(90, int(os.environ.get("GITHUB_RETENTION_DAYS", "90")))
        item = upload(store, input_value("name", args.name or "artifact"), input_value("path", args.path), retention,
                      boolean(input_value("include-hidden-files", "false")), int(input_value("compression-level", "6")),
                      boolean(input_value("overwrite", "false")), input_value("if-no-files-found", "warn"))
        print(json.dumps(item))
    elif args.command in ("download", "action-download"):
        download(store, input_value("path", args.path), input_value("name", args.name), input_value("pattern", args.pattern),
                 input_value("run-id", args.run_id), input_value("run-attempt", args.run_attempt),
                 boolean(input_value("merge-multiple", "false")), args.archive, args.max_bytes)
    else:
        print(json.dumps(store.manifests(args.run_id, args.run_attempt)))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        print(f"artifact request failed: HTTP {exc.code} ({exc.reason})", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as exc:
        print(f"artifact operation failed: {exc}", file=sys.stderr)
        sys.exit(1)
