'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

// go test keys each file a test opens by path, size, mode and mtime, not by
// content (cmd/go/internal/test hashOpen), and a checkout writes every file at
// checkout time, so no result recorded in one checkout matches another. Giving
// each tracked file an mtime derived from its bytes makes the key a function of
// the content again.
//
// The time is EPOCH plus 29 bits of whole seconds and 19 bits of binary
// fraction taken from a SHA-256 of the bytes: always years older than go test's
// two-second cutoff, before 2038 for filesystems with 32-bit seconds, and exact
// as a double. libuv turns that double into a timespec and keeps whole
// microseconds; a 2^-19 s step is 1.9 µs, so distinct fractions stay distinct
// and the stored value never depends on rounding.
const EPOCH = 946684800; // 2000-01-01T00:00:00Z
const FRACTION = 2 ** 19;
// Versioned so a future derivation never reproduces this one's times.
const DOMAIN = Buffer.from('go-ci-actions test input v1\0');
const GITLINK = '160000';
const READ_SIZE = 1 << 20;
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);

function derivedTime(digest) {
  const bits = digest.readUIntBE(0, 6);
  return EPOCH + Math.floor(bits / FRACTION) + (bits % FRACTION) / FRACTION;
}

function fileDigest(file, buffer) {
  const hash = crypto.createHash('sha256').update(DOMAIN);
  const fd = fs.openSync(file, 'r');
  try {
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest();
}

// Git paths are bytes. latin1 maps each byte to one character and back, so a
// path that is not UTF-8 survives the string handling below unchanged.
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args],
    {encoding: 'latin1', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe']});
}

function firstLine(error) {
  const text = String((error.stderr && error.stderr.length && error.stderr) || error.message);
  return text.trim().split('\n')[0];
}

// The work tree holding dir, provided it lies inside the workspace: setup
// never rewrites times outside the checkout it was pointed at.
function workTree(workspace, dir) {
  let root;
  try { root = git(dir, ['rev-parse', '--show-toplevel']).trim(); }
  catch (error) { return {reason: 'no Git work tree at ' + dir + ' (' + firstLine(error) + ')'}; }
  root = Buffer.from(root, 'latin1').toString();
  const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(root));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return {reason: 'the Git work tree ' + root + ' is outside the workspace'};
  }
  return {root};
}

// Index entries by path. A gitlink (submodule) is listed apart: its files
// belong to another repository's index and keep their checkout times.
function trackedPaths(root) {
  const paths = new Set(), gitlinks = new Set();
  for (const record of git(root, ['ls-files', '--stage', '-z']).split('\0')) {
    if (!record) continue;
    const mode = record.slice(0, record.indexOf(' '));
    (mode === GITLINK ? gitlinks : paths).add(record.slice(record.indexOf('\t') + 1));
  }
  return {paths, gitlinks};
}

function addParents(directories, name) {
  for (let dir = path.posix.dirname(name); !directories.has(dir); dir = path.posix.dirname(dir)) {
    directories.add(dir);
    if (dir === '.') break;
  }
}

// Stamps every tracked file and symbolic link in root with the time derived
// from what is on disk now, not from the index, so a file changed since
// checkout gets its new content's time. Directories holding them get EPOCH:
// go test hashes a directory it reads by its own stat and every entry's name
// and stat, so a fixed directory time still sees any entry added, removed or
// changed. Untracked files keep their times. Git's index caches each file's
// stat, so it is refreshed afterwards; otherwise plumbing such as
// `git diff-index --quiet HEAD` would report every stamped file as changed.
function stampWorkTree(root) {
  const buffer = Buffer.allocUnsafe(READ_SIZE);
  const base = Buffer.from(root + path.sep);
  const directories = new Set();
  const result = {files: 0, links: 0, directories: 0, absent: 0, denied: 0, refreshMs: 0};
  const {paths, gitlinks} = trackedPaths(root);
  for (const name of gitlinks) addParents(directories, name);
  for (const name of paths) {
    const file = Buffer.concat([base, Buffer.from(name, 'latin1')]);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile()) {
        const time = derivedTime(fileDigest(file, buffer));
        fs.utimesSync(file, time, time);
        result.files++;
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file, {encoding: 'buffer'});
        const time = derivedTime(crypto.createHash('sha256').update(DOMAIN).update(target).digest());
        fs.lutimesSync(file, time, time);
        result.links++;
      } else { result.absent++; continue; }
    } catch (error) {
      // Sparse checkouts and deleted files leave index entries with nothing on
      // disk. A file this user may not read or re-time keeps its checkout
      // time, which only costs its tests their cached result.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { result.absent++; continue; }
      if (DENIED.has(error.code)) { result.denied++; continue; }
      throw error;
    }
    addParents(directories, name);
  }
  for (const dir of directories) {
    try { fs.utimesSync(dir === '.' ? root : Buffer.concat([base, Buffer.from(dir, 'latin1')]), EPOCH, EPOCH); }
    catch (error) { if (!DENIED.has(error.code)) throw error; result.denied++; continue; }
    result.directories++;
  }
  if (!result.files && !result.links) return result;
  const refreshed = Date.now();
  // -q: a file that differs from the index is reported by later git commands
  // as modified, as it should be, rather than failing the refresh.
  git(root, ['update-index', '-q', '--ignore-submodules', '--refresh']);
  result.refreshMs = Date.now() - refreshed;
  return result;
}

// The test-input-mtimes policy: content stamps the work tree holding
// go-version-file; off, or cache-mode off (which keeps no results to reuse),
// leaves the checkout as it is. A workspace that is not a Git checkout, or Git
// that cannot read it, is reported and left alone: the job then runs its
// tests as it would without this.
function testInputMtimes({mode, cacheMode, workspace, versionFile}) {
  if (!['content', 'off'].includes(mode)) throw new Error('test-input-mtimes must be content or off');
  if (mode === 'off') return {state: 'off', message: 'off'};
  if (cacheMode === 'off') return {state: 'off', message: 'off, cache-mode is off'};
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('GITHUB_WORKSPACE must be an absolute path');
  const dir = path.resolve(workspace, path.dirname(versionFile || 'go.mod'));
  const tree = workTree(workspace, dir);
  if (!tree.root) return {state: 'off', message: 'unchanged, ' + tree.reason, notice: true};
  const started = Date.now();
  const stamped = stampWorkTree(tree.root);
  const elapsed = Date.now() - started;
  const skipped = [];
  if (stamped.absent) skipped.push(stamped.absent + ' index entries not on disk');
  if (stamped.denied) skipped.push(stamped.denied + ' paths this user may not re-time');
  return {
    state: 'content', root: tree.root, ...stamped, elapsedMs: elapsed,
    message: 'content, ' + stamped.files + ' files, ' + stamped.links + ' symbolic links and ' +
      stamped.directories + ' directories in ' + tree.root + ' stamped in ' + elapsed + ' ms (index refresh ' +
      stamped.refreshMs + ' ms)' + (skipped.length ? '; skipped ' + skipped.join(', ') : '')
  };
}

module.exports = {EPOCH, derivedTime, stampWorkTree, testInputMtimes};
