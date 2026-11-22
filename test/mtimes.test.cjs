'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {EPOCH, derivedTime, stampWorkTree, testInputMtimes} = require('../lib/mtimes.cjs');

// The developer's Git configuration (signing, trustctime, hooks) must not
// change what these tests see.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}
function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

const FILES = {
  'go.mod': 'module example.com/app\n',
  'pkg/x.go': 'package pkg\n',
  'pkg/testdata/fixture.txt': 'alpha\n',
  'pkg/testdata/nested/more.txt': 'more\n',
  'docs/readme.md': '# app\n',
};
// An origin with regular files, an executable, a symbolic link and a
// submodule entry, at two commits that differ only in a same-size fixture edit.
function origin(t) {
  const dir = tempDir(t, 'go-ci-mtimes-origin-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), content);
  }
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', {mode: 0o755});
  fs.symlinkSync('pkg/x.go', path.join(dir, 'link'));
  git(dir, 'add', '-A');
  git(dir, 'update-index', '--add', '--cacheinfo', '160000,' + '1'.repeat(40) + ',vendor/sub');
  git(dir, 'commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'pkg/testdata/fixture.txt'), 'omega\n');
  git(dir, 'add', 'pkg/testdata/fixture.txt');
  git(dir, 'commit', '-q', '-m', 'same-size edit');
  return dir;
}
function checkout(t, from, ref = 'main') {
  const dir = path.join(tempDir(t, 'go-ci-mtimes-checkout-'), 'repo');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', from, dir], {stdio: 'ignore'});
  git(dir, 'checkout', '-q', '--detach', ref);
  return dir;
}
// Every path's mtime in nanoseconds, leaving out .git and the submodule
// directory, which belongs to another checkout.
function times(root) {
  const result = {};
  for (const name of fs.readdirSync(root, {recursive: true})) {
    if (['.git', path.join('vendor', 'sub')].some(skip => name === skip || name.startsWith(skip + path.sep))) continue;
    result[name] = fs.lstatSync(path.join(root, name), {bigint: true}).mtimeNs;
  }
  result['.'] = fs.statSync(root, {bigint: true}).mtimeNs;
  return result;
}
const seconds = ns => Number(ns / 1000000000n);
const stampTime = content => derivedTime(crypto.createHash('sha256')
  .update('go-ci-actions test input v1\0').update(content).digest());
// The stored time in whole microseconds: the fraction is k/2^19 s, and libuv
// keeps whole microseconds of it.
function micros(time) {
  const whole = Math.floor(time);
  return BigInt(whole) * 1000000n + BigInt(Math.floor((time - whole) * 2 ** 19 * 1e6 / 2 ** 19));
}

test('a derived time is exact, years old and spans 2^29 seconds', () => {
  assert.equal(derivedTime(Buffer.alloc(32)), EPOCH);
  const top = Buffer.alloc(32);
  top.fill(0xff, 0, 6);
  assert.equal(derivedTime(top), EPOCH + 2 ** 29 - 2 ** -19);
  for (let i = 0; i < 1000; i++) {
    const time = derivedTime(crypto.randomBytes(32));
    assert.ok(time >= EPOCH && time < EPOCH + 2 ** 29, String(time));
    assert.ok(Number.isInteger(time * 2 ** 19), 'a double holds the time exactly');
    assert.ok(time < Date.UTC(2017, 1) / 1000, 'before 2038 and years older than go test\'s cutoff');
  }
});

test('adjacent fractions stay distinct on disk', t => {
  const dir = tempDir(t, 'go-ci-mtimes-fraction-');
  const stored = [];
  for (const low of [0, 1, 2, 3]) {
    const digest = Buffer.alloc(32);
    digest.writeUIntBE(0x123456 * 2 ** 19 + low, 0, 6);
    const file = path.join(dir, String(low));
    fs.writeFileSync(file, '');
    fs.utimesSync(file, derivedTime(digest), derivedTime(digest));
    stored.push(fs.statSync(file, {bigint: true}).mtimeNs);
  }
  assert.equal(new Set(stored).size, 4, stored.join(' '));
});

test('two checkouts of a commit get identical times for every tracked path', t => {
  const from = origin(t);
  const first = checkout(t, from), second = checkout(t, from);
  const before = times(first);
  const result = stampWorkTree(first);
  stampWorkTree(second);
  assert.deepEqual(times(first), times(second));
  assert.deepEqual({files: result.files, links: result.links, absent: result.absent, denied: result.denied},
    {files: 6, links: 1, absent: 0, denied: 0});
  assert.notDeepEqual(times(first), before);
  const after = times(first);
  assert.equal(after['pkg/testdata/fixture.txt'] / 1000n, micros(stampTime('omega\n')));
  for (const dir of ['.', 'pkg', 'pkg/testdata', 'pkg/testdata/nested', 'docs', 'vendor']) {
    assert.equal(after[dir], BigInt(EPOCH) * 1000000000n, dir);
  }
  const submodule = fs.statSync(path.join(first, 'vendor/sub'), {bigint: true}).mtimeNs;
  assert.ok(submodule > BigInt(Date.UTC(2020, 0)) * 1000000n, 'a submodule directory keeps its checkout time');
});

test('a same-size edit changes only the edited file\'s time', t => {
  const from = origin(t);
  const edited = checkout(t, from), previous = checkout(t, from, 'main~1');
  stampWorkTree(edited);
  stampWorkTree(previous);
  const a = times(edited), b = times(previous);
  const differ = Object.keys(a).filter(name => a[name] !== b[name]);
  assert.deepEqual(differ, ['pkg/testdata/fixture.txt']);
});

test('a file changed after checkout is stamped from its new content, and Git still sees the change', t => {
  const from = origin(t);
  const committed = checkout(t, from), changed = checkout(t, from, 'main~1');
  fs.writeFileSync(path.join(changed, 'pkg/testdata/fixture.txt'), 'omega\n');
  stampWorkTree(committed);
  stampWorkTree(changed);
  assert.equal(times(changed)['pkg/testdata/fixture.txt'], times(committed)['pkg/testdata/fixture.txt']);
  assert.equal(git(changed, 'status', '--porcelain'), ' M pkg/testdata/fixture.txt\n');
  assert.equal(spawnSync('git', ['-C', changed, 'diff-index', '--quiet', 'HEAD', '--']).status, 1);
});

test('the index is refreshed, so plumbing reports a stamped checkout as clean', t => {
  const from = origin(t);
  const dir = checkout(t, from);
  stampWorkTree(dir);
  assert.equal(spawnSync('git', ['-C', dir, 'diff-files', '--quiet']).status, 0);
  assert.equal(spawnSync('git', ['-C', dir, 'diff-index', '--quiet', 'HEAD', '--']).status, 0);
});

test('untracked files keep their times and absent index entries are counted', t => {
  const from = origin(t);
  const dir = checkout(t, from);
  const untracked = path.join(dir, 'pkg/testdata/generated.txt');
  fs.writeFileSync(untracked, 'generated\n');
  fs.utimesSync(untracked, 1700000000, 1700000000);
  fs.rmSync(path.join(dir, 'docs/readme.md'));
  const result = stampWorkTree(dir);
  assert.equal(seconds(fs.statSync(untracked, {bigint: true}).mtimeNs), 1700000000);
  assert.equal(result.absent, 1);
  assert.equal(result.files, 5);
});

test('a symbolic link is stamped from its target path without touching the target', t => {
  const from = origin(t);
  const dir = checkout(t, from);
  stampWorkTree(dir);
  const link = fs.lstatSync(path.join(dir, 'link'), {bigint: true}).mtimeNs;
  const target = fs.statSync(path.join(dir, 'pkg/x.go'), {bigint: true}).mtimeNs;
  assert.equal(link / 1000n, micros(stampTime('pkg/x.go')));
  assert.equal(target / 1000n, micros(stampTime('package pkg\n')));
});

test('the policy stamps the work tree holding go-version-file', t => {
  const from = origin(t);
  const workspace = tempDir(t, 'go-ci-mtimes-workspace-');
  const dir = path.join(workspace, 'app');
  execFileSync('git', ['clone', '-q', from, dir], {stdio: 'ignore'});
  const result = testInputMtimes({mode: 'content', cacheMode: 'read-only', workspace, versionFile: 'app/go.mod'});
  assert.equal(result.state, 'content');
  assert.equal(result.root, dir);
  assert.match(result.message, /^content, 6 files, 1 symbolic links and 6 directories in .* stamped in \d+ ms/);
  assert.equal(seconds(fs.statSync(path.join(dir, 'go.mod'), {bigint: true}).mtimeNs) < Date.UTC(2017, 1) / 1000, true);
});

test('off, cache-mode off and a workspace without Git leave the checkout alone', t => {
  const from = origin(t);
  const workspace = tempDir(t, 'go-ci-mtimes-workspace-');
  const dir = path.join(workspace, 'app');
  execFileSync('git', ['clone', '-q', from, dir], {stdio: 'ignore'});
  const before = times(dir);
  assert.deepEqual(testInputMtimes({mode: 'off', cacheMode: 'read-write', workspace, versionFile: 'app/go.mod'}),
    {state: 'off', message: 'off'});
  assert.deepEqual(testInputMtimes({mode: 'content', cacheMode: 'off', workspace, versionFile: 'app/go.mod'}),
    {state: 'off', message: 'off, cache-mode is off'});
  assert.deepEqual(times(dir), before);
  const plain = tempDir(t, 'go-ci-mtimes-plain-');
  const result = testInputMtimes({mode: 'content', cacheMode: 'read-write', workspace: plain, versionFile: 'go.mod'});
  assert.equal(result.state, 'off');
  assert.equal(result.notice, true);
  assert.match(result.message, /^unchanged, no Git work tree at /);
});

test('a work tree outside the workspace is refused and an unknown mode fails', t => {
  const from = origin(t);
  const dir = checkout(t, from);
  const workspace = path.join(dir, 'pkg');
  const result = testInputMtimes({mode: 'content', cacheMode: 'read-write', workspace, versionFile: 'go.mod'});
  assert.equal(result.state, 'off');
  assert.match(result.message, /is outside the workspace$/);
  assert.throws(() => testInputMtimes({mode: 'on', cacheMode: 'read-write', workspace, versionFile: 'go.mod'}),
    /test-input-mtimes must be content or off/);
});
