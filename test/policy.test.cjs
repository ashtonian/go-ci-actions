'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {identity, hours, validatePaths} = require('../lib/policy.cjs');
const {trim, measure} = require('../lib/cache.cjs');
const values = {workflow: 'CI', job: 'test', workload: '{"race":true}',
  'dependency-hash': 'abc123', os: 'Linux', arch: 'X64', 'run-id': '123', 'run-attempt': '1',
  'cache-mode': 'read-write', 'cache-key-prefix': 'go-v1',
  'seed-from-other-workloads': 'true', 'max-staleness-hours': '2'};
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
test('invalid modes, injected key fields and retention values fail closed', () => {
  for (const raw of ['-1', '1.5', 'NaN', 'Infinity', '', '1e3', '8761']) assert.throws(() => hours(raw));
  assert.equal(hours('0'), 0);
  assert.throws(() => identity({...values, 'cache-mode': 'write'}, 'go1.26.9'));
  assert.throws(() => identity({...values, os: 'Linux\nkey=bad'}, 'go1.26.9'));
  assert.throws(() => identity({...values, 'cache-key-prefix': 'a'.repeat(513)}, 'go1.26.9'));
  assert.throws(() => identity({...values, 'dependency-hash': 'x\nkey=bad'}, 'go1.26.9'));
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
