'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildCache, identity, hours, validatePaths} = require('../lib/policy.cjs');
const {trim, measure} = require('../lib/cache.cjs');
const values = {workflow: 'CI', job: 'test', workload: '{"race":true}',
  'dependency-hash': 'abc123', os: 'Linux', arch: 'X64', 'run-id': '123', 'run-attempt': '1',
  'cache-mode': 'read-write', 'cache-key-prefix': 'go-v1',
  'seed-from-other-workloads': 'true', 'max-staleness-hours': '2', backend: 'github'};
test('workloads, compilers, manifests and reruns have separate save keys', () => {
  const original = identity(values, 'go1.26.9').key;
  for (const field of ['workflow', 'job', 'workload', 'os', 'arch', 'run-id', 'run-attempt']) {
    assert.notEqual(identity({...values, [field]: values[field] + '2'}, 'go1.26.9').key, original);
  }
  assert.notEqual(identity({...values, 'dependency-hash': 'def456'}, 'go1.26.9').key, original);
  assert.notEqual(identity(values, 'go1.27.2').key, original);
  assert.equal(identity({...values, 'cache-mode': 'read-only'}, 'go1.26.9').key, original);
});
test('restore order preserves workload affinity and optional seeding', () => {
  const full = identity(values, 'go1.26.9');
  const prefixes = full['restore-keys'].split('\n');
  assert.equal(prefixes.length, 3);
  assert.ok(full.key.startsWith(prefixes[0]));
  assert.ok(prefixes[0].startsWith(prefixes[1]));
  assert.equal(prefixes[2], 'go-v1-Linux-X64-go1.26.9-');
  assert.equal(identity({...values, 'seed-from-other-workloads': 'false'}, 'go1.26.9')['restore-keys'].split('\n').length, 2);
  assert.ok(identity({...values, 'dependency-hash': ''}, 'go1.26.9').key.includes('--123-1'));
});
test('remote backend archives modules once per workload and manifest set', () => {
  const remote = {...values, backend: 'remote'};
  const result = identity(remote, 'go1.26.9');
  assert.equal(identity({...remote, 'run-id': '999', 'run-attempt': '2'}, 'go1.26.9').key, result.key);
  assert.equal(identity(remote, 'go1.27.2').key, result.key, 'module content does not depend on the compiler');
  for (const field of ['workflow', 'job', 'workload', 'os', 'arch', 'dependency-hash']) {
    assert.notEqual(identity({...remote, [field]: remote[field] + '2'}, 'go1.26.9').key, result.key);
  }
  assert.ok(!identity(values, 'go1.26.9').key.startsWith('go-v1-mod-'), 'separate from build archives');
  const prefixes = result['restore-keys'].split('\n');
  assert.deepEqual(prefixes.length, 2);
  assert.ok(result.key.startsWith(prefixes[0]));
  assert.equal(prefixes[1], 'go-v1-mod-Linux-X64-');
  assert.equal(identity({...remote, 'seed-from-other-workloads': 'false'}, 'go1.26.9')['restore-keys'], prefixes[0]);
});
test('build cache backend follows what the runner provides', t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-bin-'));
  t.after(() => fs.rmSync(bin, {recursive: true, force: true}));
  const plugin = path.join(bin, 'gocacheprog');
  fs.writeFileSync(plugin, '#!/bin/sh\n', {mode: 0o755});
  const runner = {GOCACHEPROG_REMOTE_URL: 'http://cache:8080', PATH: '/nonexistent' + path.delimiter + bin,
    RUNNER_TEMP: '/runner/temp', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token'};
  const cases = [
    {name: 'remote', env: runner, want: {backend: 'remote', dir: '/runner/temp/gocacheprog',
      env: {GOCACHEPROG: plugin, GOCACHEPROG_DIR: '/runner/temp/gocacheprog'}, notices: []}},
    {name: 'remote read-only', mode: 'read-only', env: runner, want: {backend: 'remote', dir: '/runner/temp/gocacheprog',
      env: {GOCACHEPROG: plugin, GOCACHEPROG_DIR: '/runner/temp/gocacheprog', GOCACHEPROG_READ_ONLY: 'true'}, notices: []}},
    {name: 'runner-chosen directory', env: {...runner, GOCACHEPROG_DIR: '/cache'}, want: {backend: 'remote', dir: '/cache',
      env: {GOCACHEPROG: plugin, GOCACHEPROG_DIR: '/cache'}, notices: []}},
    {name: 'no remote cache', env: {PATH: bin}, want: {backend: 'github', env: {}, notices: []}},
    {name: 'opted out', requested: 'github', env: runner, want: {backend: 'github', env: {}, notices: []}},
    {name: 'disabled', mode: 'off', env: runner, want: {backend: 'off', env: {}, notices: []}},
    {name: 'inherited plugin is cleared', requested: 'github', env: {...runner, GOCACHEPROG: '/other'},
      want: {backend: 'github', env: {GOCACHEPROG: ''}, notices: []}},
  ];
  for (const c of cases) {
    assert.deepEqual(buildCache(c.requested || 'auto', c.mode || 'read-write', c.env), c.want, c.name);
  }
  const missing = buildCache('auto', 'read-write', {...runner, PATH: '/nonexistent'});
  assert.equal(missing.backend, 'github');
  assert.match(missing.notices[0], /gocacheprog is not on PATH/);
  const tokenless = buildCache('auto', 'read-write', {...runner, ACTIONS_ID_TOKEN_REQUEST_URL: ''});
  assert.equal(tokenless.backend, 'remote');
  assert.match(tokenless.notices[0], /id-token: write/);
  assert.deepEqual(buildCache('auto', 'read-only', {...runner, ACTIONS_ID_TOKEN_REQUEST_URL: ''}).notices, []);
  assert.throws(() => buildCache('remote', 'read-write', runner), /auto or github/);
  assert.throws(() => buildCache('auto', 'read-write', {...runner, RUNNER_TEMP: ''}), /RUNNER_TEMP/);
});
test('invalid modes, injected key fields and retention values fail closed', () => {
  for (const raw of ['-1', '1.5', 'NaN', 'Infinity', '', '1e3', '8761']) assert.throws(() => hours(raw));
  assert.equal(hours('0'), 0);
  assert.throws(() => identity({...values, 'cache-mode': 'write'}, 'go1.26.9'));
  assert.throws(() => identity({...values, os: 'Linux\nkey=bad'}, 'go1.26.9'));
  assert.throws(() => identity({...values, 'cache-key-prefix': 'a'.repeat(513)}, 'go1.26.9'));
  assert.throws(() => identity({...values, 'dependency-hash': 'x\nkey=bad'}, 'go1.26.9'));
  assert.throws(() => identity({...values, backend: ''}, 'go1.26.9'));
});
test('trim retains early-used objects in long jobs and skips symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-trim-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const cache = path.join(root, 'build'), outside = path.join(root, 'outside');
  fs.mkdirSync(cache);
  fs.writeFileSync(outside, 'keep outside');
  fs.symlinkSync(outside, path.join(cache, 'link'));
  const began = Date.now() - 4 * 3600000;
  const files = {stale: began - 3 * 3600000, usedEarly: began + 1000, recentlyTouched: began - 3600000};
  for (const [name, mtime] of Object.entries(files)) {
    const file = path.join(cache, name);
    fs.writeFileSync(file, 'cached');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  }
  const result = trim(cache, began - 2 * 3600000);
  assert.equal(result.removedFiles, 1);
  assert.equal(result.files, 2);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
  assert.equal(fs.lstatSync(path.join(cache, 'link')).isSymbolicLink(), true);
  assert.deepEqual(measure(cache), {bytes: 12, files: 2});
});
test('broad, overlapping and symlinked cache roots are rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-paths-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.throws(() => validatePaths('/', path.join(root, 'modules')));
  assert.throws(() => validatePaths(os.homedir(), path.join(root, 'modules')));
  assert.throws(() => validatePaths(root, path.join(root, 'nested')));
  fs.symlinkSync(root, path.join(root, 'link'));
  assert.throws(() => validatePaths(path.join(root, 'link'), path.join(root, 'modules')));
  validatePaths(path.join(root, 'build'), path.join(root, 'modules'));
  fs.mkdirSync(path.join(root, 'build'));
  assert.throws(() => validatePaths(path.join(root, 'build'), path.join(root, 'link/build')));
});
