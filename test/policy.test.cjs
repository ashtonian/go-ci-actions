'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {archivePaths, buildCache, identity, hours, moduleProxy, npmRegistry, validatePaths} = require('../lib/policy.cjs');
const {trim, measure} = require('../lib/cache.cjs');
const values = {workflow: 'CI', job: 'test', workload: '{"race":true}',
  'dependency-hash': 'abc123', os: 'Linux', arch: 'X64', 'run-id': '123', 'run-attempt': '1',
  'cache-mode': 'read-write', 'cache-key-prefix': 'go-v1',
  'seed-from-other-workloads': 'true', 'max-staleness-hours': '2', backend: 'github', modules: 'archive'};
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
test('a module proxy takes modules out of every archive', () => {
  assert.deepEqual(identity({...values, backend: 'remote', modules: 'proxy'}, 'go1.26.9'), {key: '', 'restore-keys': ''});
  const buildOnly = identity({...values, modules: 'proxy'}, 'go1.26.9');
  assert.match(buildOnly.key, /^go-v1-build-Linux-X64-go1\.26\.9-[0-9a-f]{16}-abc123-123-1$/);
  for (const prefix of buildOnly['restore-keys'].split('\n')) {
    assert.ok(prefix.startsWith('go-v1-build-'), 'never restores an archive that carries modules: ' + prefix);
  }
  assert.notEqual(buildOnly.key, identity(values, 'go1.26.9').key);
  assert.throws(() => identity({...values, modules: ''}, 'go1.26.9'), /module source/);
  const cases = [
    ['github', 'archive', '/b\n/m'], ['github', 'proxy', '/b'], ['remote', 'archive', '/m'], ['remote', 'proxy', ''],
  ];
  for (const [backend, modules, want] of cases) assert.equal(archivePaths(backend, modules, '/b', '/m'), want, backend + '/' + modules);
});
test('the runner module proxy goes first only when ready and the job has no GOPROXY', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-proxy-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bundle = path.join(root, 'go-ci-cache', 'v1');
  fs.mkdirSync(bundle, {recursive: true});
  fs.writeFileSync(path.join(bundle, 'config.json'),
    JSON.stringify({version: 1, moduleProxyURL: 'http://bundle-proxy:3000'}));
  const ready = async () => ({ready: true});
  const fallback = 'https://proxy.golang.org,direct';
  const cases = [
    {name: 'environment', env: {GO_MODULE_PROXY_URL: 'http://proxy:3000'},
      want: {url: 'http://proxy:3000', env: {GOPROXY: 'http://proxy:3000|' + fallback}, notices: []}},
    {name: 'bundle', env: {RUNNER_TOOL_CACHE: root},
      want: {url: 'http://bundle-proxy:3000', env: {GOPROXY: 'http://bundle-proxy:3000|' + fallback}, notices: []}},
    {name: 'environment over bundle', env: {RUNNER_TOOL_CACHE: root, GO_MODULE_PROXY_URL: 'http://proxy:3000'},
      want: {url: 'http://proxy:3000', env: {GOPROXY: 'http://proxy:3000|' + fallback}, notices: []}},
    {name: 'job list kept behind the proxy', env: {GO_MODULE_PROXY_URL: 'http://proxy:3000'}, goProxy: 'https://mirror.example',
      want: {url: 'http://proxy:3000', env: {GOPROXY: 'http://proxy:3000|https://mirror.example'}, notices: []}},
    {name: 'job sets GOPROXY', env: {GO_MODULE_PROXY_URL: 'http://proxy:3000', GOPROXY: 'off'},
      want: {url: '', env: {}, notices: []}},
    {name: 'GOENV forbids downloads', env: {GO_MODULE_PROXY_URL: 'http://proxy:3000'}, goProxy: 'off',
      want: {url: '', env: {}, notices: []}},
    {name: 'no proxy', env: {}, want: {url: '', env: {}, notices: []}},
    {name: 'opted out', requested: 'off', env: {GO_MODULE_PROXY_URL: 'http://proxy:3000'},
      want: {url: '', env: {}, notices: []}},
  ];
  for (const c of cases) {
    assert.deepEqual(await moduleProxy(c.requested || 'auto', c.env, c.goProxy || fallback, ready), c.want, c.name);
  }
  const down = await moduleProxy('auto', {GO_MODULE_PROXY_URL: 'http://proxy:3000'}, fallback,
    async () => ({ready: false, reason: 'ECONNREFUSED'}));
  assert.equal(down.url, '');
  assert.deepEqual(down.env, {});
  assert.match(down.notices[0], /http:\/\/proxy:3000 is not ready \(ECONNREFUSED\)/);
  for (const url of ['http://a:1,http://b:2', 'http://a:1|direct', 'file:///tmp', 'http://user:pw@proxy', 'http://proxy\n']) {
    await assert.rejects(moduleProxy('auto', {GO_MODULE_PROXY_URL: url}, fallback, ready), /GO_MODULE_PROXY_URL/, url);
  }
  await assert.rejects(moduleProxy('on', {}, fallback, ready), /auto or off/);
  fs.writeFileSync(path.join(bundle, 'config.json'), JSON.stringify({version: 1, moduleProxyURL: 'http://a,b'}));
  await assert.rejects(moduleProxy('auto', {RUNNER_TOOL_CACHE: root}, fallback, ready), /moduleProxyURL/);
  assert.deepEqual(await moduleProxy('off', {RUNNER_TOOL_CACHE: root}, fallback, ready), {url: '', env: {}, notices: []},
    'off never reads the bundle');
});
test('the runner npm registry cache is used only when ready and the job names no registry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-npm-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bundle = path.join(root, 'go-ci-cache', 'v1');
  fs.mkdirSync(bundle, {recursive: true});
  fs.writeFileSync(path.join(bundle, 'config.json'),
    JSON.stringify({version: 1, npmRegistryURL: 'http://bundle-npm:4873'}));
  const ready = async () => ({ready: true});
  const using = url => ({
    url: url + '/',
    env: {pnpm_config_registry: url + '/', npm_config_registry: url + '/', COREPACK_NPM_REGISTRY: url},
    notices: []
  });
  const none = {url: '', env: {}, notices: []};
  const cases = [
    {name: 'environment', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873'}, want: using('http://npm:4873')},
    {name: 'trailing slash', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873/'}, want: using('http://npm:4873')},
    {name: 'bundle', env: {RUNNER_TOOL_CACHE: root}, want: using('http://bundle-npm:4873')},
    {name: 'environment over bundle', env: {RUNNER_TOOL_CACHE: root, NPM_REGISTRY_CACHE_URL: 'http://npm:4873'},
      want: using('http://npm:4873')},
    {name: 'job sets pnpm registry', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873', pnpm_config_registry: 'https://r.example/'},
      want: none},
    {name: 'job sets npm registry', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873', NPM_CONFIG_REGISTRY: 'https://r.example/'},
      want: none},
    {name: 'job sets Corepack registry', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873', COREPACK_NPM_REGISTRY: 'https://r.example'},
      want: none},
    {name: 'no cache', env: {}, want: none},
    {name: 'opted out', requested: 'off', env: {NPM_REGISTRY_CACHE_URL: 'http://npm:4873'}, want: none},
  ];
  for (const c of cases) assert.deepEqual(await npmRegistry(c.requested || 'auto', c.env, ready), c.want, c.name);
  const down = await npmRegistry('auto', {NPM_REGISTRY_CACHE_URL: 'http://npm:4873'},
    async () => ({ready: false, reason: 'ECONNREFUSED'}));
  assert.deepEqual(down.env, {});
  assert.equal(down.url, '');
  assert.match(down.notices[0], /http:\/\/npm:4873 is not ready \(ECONNREFUSED\)/);
  for (const url of ['http://a:1,http://b:2', 'file:///tmp', 'http://user:pw@npm', 'http://npm\n']) {
    await assert.rejects(npmRegistry('auto', {NPM_REGISTRY_CACHE_URL: url}, ready), /NPM_REGISTRY_CACHE_URL/, url);
  }
  await assert.rejects(npmRegistry('on', {}, ready), /auto or off/);
  fs.writeFileSync(path.join(bundle, 'config.json'), JSON.stringify({version: 1, npmRegistryURL: 'ftp://npm'}));
  await assert.rejects(npmRegistry('auto', {RUNNER_TOOL_CACHE: root}, ready), /npmRegistryURL/);
  assert.deepEqual(await npmRegistry('off', {RUNNER_TOOL_CACHE: root}, ready), none, 'off never reads the bundle');
});
test('the npm registry probe asks /-/ping and the module proxy probe /readyz', async t => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((request, response) => { seen.push(request.url); response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await npmRegistry('auto', {NPM_REGISTRY_CACHE_URL: url + '/'})).url, url + '/');
  assert.equal((await moduleProxy('auto', {GO_MODULE_PROXY_URL: url}, 'https://proxy.golang.org,direct')).url, url);
  assert.deepEqual(seen, ['/-/ping', '/readyz']);
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
test('mounted cache respects opt-out, endpoint overrides and invalid manifests', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-mounted-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bundle = path.join(root, 'go-ci-cache', 'v1');
  fs.mkdirSync(bundle, {recursive: true});
  const manifest = path.join(bundle, 'config.json');
  const plugin = path.join(bundle, 'gocacheprog');
  const env = {RUNNER_TOOL_CACHE: root, RUNNER_TEMP: '/runner/temp', PATH: '/nonexistent'};
  fs.writeFileSync(manifest, JSON.stringify({version: 1, remoteURL: 'https://cache.example/cache'}));
  assert.equal(buildCache('auto', 'read-write', env).backend, 'github', 'missing helper falls back');
  fs.writeFileSync(plugin, '#!/bin/sh\n', {mode: 0o755});
  const readOnly = buildCache('auto', 'read-only', env);
  assert.equal(readOnly.backend, 'remote');
  assert.equal(readOnly.env.GOCACHEPROG_READ_ONLY, 'true');
  assert.equal(readOnly.env.GOCACHEPROG_REMOTE_URL, 'https://cache.example/cache');
  const override = buildCache('auto', 'read-write', {...env, GOCACHEPROG_REMOTE_URL: 'https://override.example'});
  assert.equal(override.env.GOCACHEPROG, plugin);
  assert.equal(override.env.GOCACHEPROG_REMOTE_URL, undefined, 'preserve explicit endpoint');
  fs.writeFileSync(manifest, JSON.stringify({version: 1, moduleProxyURL: 'http://proxy:3000'}));
  assert.equal(buildCache('auto', 'read-write', env).backend, 'github', 'a proxy-only bundle provides no build cache');
  for (const content of ['{', 'null', JSON.stringify({version: 2, remoteURL: 'https://cache.example'}),
    JSON.stringify({version: 1, remoteURL: 'file:///tmp/cache'}),
    JSON.stringify({version: 1, remoteURL: 'https://user:password@cache.example'}),
    JSON.stringify({version: 1, remoteURL: 'https://cache.example\n'}),
    JSON.stringify({version: 1, remoteURL: 42}),
    JSON.stringify({version: 1, remoteURL: 'https://cache.example', moduleProxyURL: 'ftp://proxy'})]) {
    fs.writeFileSync(manifest, content);
    assert.throws(() => buildCache('auto', 'read-write', env), /runner cache|Runner cache/);
    assert.equal(buildCache('github', 'read-write', env).backend, 'github');
    assert.equal(buildCache('auto', 'off', env).backend, 'off');
  }
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
