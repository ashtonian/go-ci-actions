'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {buildCache, nodeCount, refScope} = require('../lib/buildcache.cjs');

const MAIN = {name: 'push', ref: 'refs/heads/main', defaultBranch: 'main'};
const PR = {name: 'pull_request', ref: 'refs/pull/42/merge', number: 42, defaultBranch: 'main'};
const REGISTRY = {registry: 'harbor.example.com', repository: 'karsto/buildcache/server', scope: 'server',
  platforms: '', mode: 'max', nodes: 1};
const EXPORT = ',mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true';

test('the default branch writes and reads the shared tag', () => {
  assert.deepEqual(buildCache({...REGISTRY, event: MAIN}), {
    backend: 'registry',
    cacheFrom: ['type=registry,ref=harbor.example.com/karsto/buildcache/server:server'],
    cacheTo: 'type=registry,ref=harbor.example.com/karsto/buildcache/server:server' + EXPORT
  });
});

test('a pull request writes its own tag and reads it before the default branch\'s', () => {
  const cache = buildCache({...REGISTRY, event: PR});
  assert.deepEqual(cache.cacheFrom, [
    'type=registry,ref=harbor.example.com/karsto/buildcache/server:server--pr-42',
    'type=registry,ref=harbor.example.com/karsto/buildcache/server:server'
  ]);
  assert.equal(cache.cacheTo, 'type=registry,ref=harbor.example.com/karsto/buildcache/server:server--pr-42' + EXPORT);
});

test('other refs never write the default branch\'s tag', () => {
  assert.equal(refScope({name: 'push', ref: 'refs/heads/Feat/Cache_X', defaultBranch: 'main'}), 'branch-feat-cache_x');
  assert.equal(refScope({name: 'schedule', ref: 'refs/heads/main', defaultBranch: 'main'}), '');
  assert.equal(refScope({name: 'push', ref: 'refs/tags/v1.2.0', defaultBranch: 'main'}), 'ref-refs-tags-v1.2.0');
  assert.equal(refScope({name: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-1', defaultBranch: 'main'}),
    'merge-group');
  assert.throws(() => refScope({name: 'pull_request', ref: 'refs/pull/1/merge', defaultBranch: 'main'}), /without a number/);
});

test('each platform gets its own tag', () => {
  const amd = buildCache({...REGISTRY, platforms: 'linux/amd64', event: PR});
  const arm = buildCache({...REGISTRY, platforms: 'linux/arm64', event: PR});
  assert.match(amd.cacheTo, /:server--linux-amd64--pr-42,/);
  assert.match(arm.cacheTo, /:server--linux-arm64--pr-42,/);
  assert.match(buildCache({...REGISTRY, platforms: 'linux/arm64, linux/amd64', event: MAIN}).cacheTo,
    /:server--linux-amd64_linux-arm64,/, 'one builder node exports both platforms in one manifest');
});

test('a multi-platform cache on a multi-node builder is refused', () => {
  assert.throws(() => buildCache({...REGISTRY, platforms: 'linux/amd64,linux/arm64', nodes: 2, event: MAIN}),
    /only the platform of the node that exports last/);
  assert.doesNotThrow(() => buildCache({...REGISTRY, platforms: 'linux/arm64', nodes: 2, event: MAIN}));
});

test('without a registry the GitHub cache keeps its own branch scoping', () => {
  assert.deepEqual(buildCache({...REGISTRY, registry: '', repository: '', mode: 'min', event: PR}), {
    backend: 'gha',
    cacheFrom: ['type=gha,scope=server'],
    cacheTo: 'type=gha,scope=server,mode=min,ignore-error=true'
  });
});

test('invalid inputs fail', () => {
  for (const [override, message] of [
    [{registry: 'https://harbor.example.com'}, /host\[:port\]/],
    [{registry: 'harbor.example.com/karsto'}, /host\[:port\]/],
    [{repository: 'Karsto/Cache'}, /lower-case repository path/],
    [{repository: ''}, /lower-case repository path/],
    [{registry: '', repository: 'karsto/cache'}, /repository needs a registry/],
    [{mode: 'all'}, /mode must be max or min/],
    [{scope: '***'}, /scope must contain/],
    [{scope: 'x'.repeat(200)}, /at most 128 characters/],
  ]) {
    assert.throws(() => buildCache({...REGISTRY, event: MAIN, ...override}), message, JSON.stringify(override));
  }
});

test('the node count comes from docker buildx inspect', () => {
  const twoNodes = 'Name:          native\nDriver:        remote\n\nNodes:\nName:                  amd\nEndpoint: x\n\n' +
    'Name:                  arm\nEndpoint: y\n';
  assert.equal(nodeCount(twoNodes), 2);
  assert.equal(nodeCount('Name: default\nDriver: docker\n\nNodes:\nName: default\n'), 1);
  assert.throws(() => nodeCount('error'), /Could not read/);
});

// The packaged action against a docker stub that reports a two-node builder.
async function runAction(t, inputs, event) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-buildcache-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "Name: native\\nNodes:\\nName: amd\\nName: arm\\n"\n',
    {mode: 0o755});
  const eventPath = path.join(root, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event.payload));
  const env = {PATH: bin + path.delimiter + process.env.PATH, GITHUB_OUTPUT: path.join(root, 'output'),
    GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: event.name, GITHUB_REF: event.ref};
  for (const [name, value] of Object.entries(inputs)) env['INPUT_' + name.toUpperCase()] = value;
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(__dirname, '../buildx-cache/index.cjs')], {env, encoding: 'utf8'},
      (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr,
        output: fs.existsSync(env.GITHUB_OUTPUT) ? fs.readFileSync(env.GITHUB_OUTPUT, 'utf8') : ''}));
  });
}

test('packaged action writes the references and refuses a split multi-platform cache', async t => {
  const pr = {name: 'pull_request', ref: 'refs/pull/7/merge',
    payload: {pull_request: {number: 7}, repository: {default_branch: 'main'}}};
  const ok = await runAction(t, {registry: 'harbor.example.com', repository: 'home-ops-internal/buildcache/tools',
    scope: 'tools', platforms: 'linux/amd64', mode: 'max'}, pr);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.output, /cache-to<<[^\n]+\ntype=registry,ref=harbor\.example\.com\/home-ops-internal\/buildcache\/tools:tools--linux-amd64--pr-7,/);
  assert.match(ok.stdout, /BuildKit cache: registry/);
  const split = await runAction(t, {registry: 'harbor.example.com', repository: 'home-ops-internal/buildcache/tools',
    scope: 'tools', platforms: 'linux/amd64,linux/arm64', mode: 'max'}, pr);
  assert.equal(split.code, 1);
  assert.match(split.stderr, /builder with 2 nodes/);
});
