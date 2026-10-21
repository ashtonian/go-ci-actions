'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// readCommandFile parses the name<<delimiter files GITHUB_OUTPUT and GITHUB_ENV use.
function readCommandFile(file) {
  const values = {};
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i]);
    if (!match) continue;
    const body = [];
    while (lines[++i] !== match[2]) body.push(lines[i]);
    values[match[1]] = body.join('\n');
  }
  return values;
}

function runIdentity(t, {remote, mode = 'read-write'}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-identity-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin'), temp = path.join(root, 'temp');
  const build = path.join(root, 'go-build'), modules = path.join(root, 'go-mod');
  fs.mkdirSync(bin); fs.mkdirSync(temp);
  fs.writeFileSync(path.join(bin, 'go'), '#!/bin/sh\nprintf \'{"GOVERSION":"go1.26.9","GOCACHE":"%s","GOMODCACHE":"%s"}\' ' +
    JSON.stringify(build) + ' ' + JSON.stringify(modules) + '\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'gocacheprog'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  const inputs = {workflow: 'CI', job: 'test', workload: '', 'dependency-hash': 'abc123', os: 'Linux', arch: 'X64',
    'run-id': '123', 'run-attempt': '1', 'cache-mode': mode, 'cache-key-prefix': 'go-v1',
    'seed-from-other-workloads': 'true', 'max-staleness-hours': '2', 'build-cache-backend': 'auto'};
  const env = {PATH: bin + path.delimiter + process.env.PATH, RUNNER_TEMP: temp,
    GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_ENV: path.join(root, 'env'),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token'};
  if (remote) env.GOCACHEPROG_REMOTE_URL = 'http://127.0.0.1:9';
  for (const [name, value] of Object.entries(inputs)) env['INPUT_' + name.toUpperCase()] = value;
  const result = spawnSync(process.execPath, [path.join(__dirname, '../_identity/index.cjs')], {env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return {result, bin, temp, build, modules,
    outputs: readCommandFile(env.GITHUB_OUTPUT), exported: readCommandFile(env.GITHUB_ENV)};
}

test('packaged identity hands the build cache to the runner plugin', t => {
  const run = runIdentity(t, {remote: true});
  assert.equal(run.outputs.backend, 'remote');
  assert.equal(run.outputs.paths, run.modules, 'only modules go in the GitHub cache');
  assert.equal(run.outputs.build, path.join(run.temp, 'gocacheprog'));
  assert.match(run.outputs.key, /^go-v1-mod-Linux-X64-[0-9a-f]{16}-abc123$/);
  assert.deepEqual(run.exported, {GOCACHEPROG: path.join(run.bin, 'gocacheprog'), GOCACHEPROG_DIR: run.outputs.build});
  assert.match(run.result.stdout, /build cache: remote/);
});

test('packaged identity keeps the GitHub cache without a remote cache', t => {
  const run = runIdentity(t, {remote: false});
  assert.equal(run.outputs.backend, 'github');
  assert.equal(run.outputs.paths, run.build + '\n' + run.modules);
  assert.match(run.outputs.key, /^go-v1-Linux-X64-go1\.26\.9-[0-9a-f]{16}-abc123-123-1$/);
  assert.deepEqual(run.exported, {});
});

test('packaged identity passes read-only mode to the plugin', t => {
  const run = runIdentity(t, {remote: true, mode: 'read-only'});
  assert.equal(run.exported.GOCACHEPROG_READ_ONLY, 'true');
});
