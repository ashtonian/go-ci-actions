'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');

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

// moduleProxyStub answers /readyz with the given status, as a module proxy would.
async function moduleProxyStub(t, status) {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === '/readyz' ? status : 404;
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

// The job's module under app/ and an unrelated checkout beside it.
const MANIFESTS = {'app/go.mod': 'module app\n', 'app/go.sum': 'app sums\n', 'sibling/go.sum': 'sibling sums\n'};
function digest(files) {
  const result = crypto.createHash('sha256');
  for (const file of files) result.update(crypto.createHash('sha256').update(MANIFESTS[file]).digest());
  return result.digest('hex');
}
const APP = digest(['app/go.mod', 'app/go.sum']);

// The identity step runs as a child so the stub server keeps serving its probe.
async function runIdentity(t, {remote, mounted = false, mode = 'read-write', proxy = '', bundleProxy = '', env: extra = {},
  inputs: overrides = {}}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-identity-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin'), temp = path.join(root, 'temp'), workspace = path.join(root, 'workspace');
  const build = path.join(root, 'go-build'), modules = path.join(root, 'go-mod');
  fs.mkdirSync(bin); fs.mkdirSync(temp);
  for (const [name, content] of Object.entries(MANIFESTS)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), {recursive: true});
    fs.writeFileSync(path.join(workspace, name), content);
  }
  fs.writeFileSync(path.join(bin, 'go'), '#!/bin/sh\nprintf \'{"GOVERSION":"go1.26.9","GOCACHE":"%s","GOMODCACHE":"%s",' +
    '"GOPROXY":"https://proxy.golang.org,direct"}\' ' + JSON.stringify(build) + ' ' + JSON.stringify(modules) + '\n',
  {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'gocacheprog'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  const inputs = {workflow: 'CI', job: 'test', workload: '', 'cache-dependency-path': '', 'go-version-file': 'app/go.mod',
    os: 'Linux', arch: 'X64', 'run-id': '123', 'run-attempt': '1', 'cache-mode': mode, 'cache-key-prefix': 'go-v1',
    'seed-from-other-workloads': 'true', 'max-staleness-hours': '2', 'build-cache-backend': 'auto',
    'module-proxy': 'auto', ...overrides};
  const env = {PATH: bin + path.delimiter + process.env.PATH, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_ENV: path.join(root, 'env'),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token', ...extra};
  let mountedPlugin;
  if (mounted || bundleProxy) {
    env.RUNNER_TOOL_CACHE = path.join(root, 'mounted-tools');
    const bundle = path.join(env.RUNNER_TOOL_CACHE, 'go-ci-cache', 'v1');
    fs.mkdirSync(bundle, {recursive: true});
    const config = {version: 1};
    if (mounted) {
      mountedPlugin = path.join(bundle, 'gocacheprog');
      fs.renameSync(path.join(bin, 'gocacheprog'), mountedPlugin);
      config.remoteURL = 'http://cache:8080';
    }
    if (bundleProxy) config.moduleProxyURL = bundleProxy;
    fs.writeFileSync(path.join(bundle, 'config.json'), JSON.stringify(config));
  }
  if (remote) env.GOCACHEPROG_REMOTE_URL = 'http://127.0.0.1:9';
  if (proxy) env.GO_MODULE_PROXY_URL = proxy;
  for (const [name, value] of Object.entries(inputs)) env['INPUT_' + name.toUpperCase()] = value;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '../_identity/index.cjs')], {env, encoding: 'utf8'},
      (error, out, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(out)));
  });
  return {stdout, bin, temp, workspace, build, modules, mountedPlugin,
    outputs: readCommandFile(env.GITHUB_OUTPUT), exported: readCommandFile(env.GITHUB_ENV)};
}

test('packaged identity hands the build cache to the runner plugin', async t => {
  const run = await runIdentity(t, {remote: true});
  assert.equal(run.outputs.backend, 'remote');
  assert.equal(run.outputs.paths, run.modules, 'only modules go in the GitHub cache');
  assert.equal(run.outputs.build, path.join(run.temp, 'gocacheprog'));
  assert.match(run.outputs.key, new RegExp('^go-v1-mod-Linux-X64-[0-9a-f]{16}-' + APP + '$'));
  assert.equal(run.outputs['module-proxy'], '');
  assert.deepEqual(run.exported, {GOCACHEPROG: path.join(run.bin, 'gocacheprog'), GOCACHEPROG_DIR: run.outputs.build,
    GOLANGCI_LINT_CACHEPROG: path.join(run.bin, 'gocacheprog')});
  assert.match(run.stdout, /build cache: remote; modules: archive/);
});

test('packaged identity finds the runner cache inside a job container mount', async t => {
  const run = await runIdentity(t, {mounted: true});
  assert.equal(run.outputs.backend, 'remote');
  assert.equal(run.outputs.paths, run.modules);
  assert.equal(run.exported.GOCACHEPROG, run.mountedPlugin);
  assert.equal(run.exported.GOCACHEPROG_REMOTE_URL, 'http://cache:8080');
  assert.equal(run.exported.GOCACHEPROG_DIR, path.join(run.temp, 'gocacheprog'));
});

test('packaged identity keeps the GitHub cache without a remote cache', async t => {
  const run = await runIdentity(t, {remote: false});
  assert.equal(run.outputs.backend, 'github');
  assert.equal(run.outputs.paths, run.build + '\n' + run.modules);
  assert.match(run.outputs.key, new RegExp('^go-v1-Linux-X64-go1\\.26\\.9-[0-9a-f]{16}-' + APP + '-123-1$'));
  assert.match(run.stdout, /manifests hashed: 2$/m);
  assert.deepEqual(run.exported, {});
});

test('packaged identity passes read-only mode to the plugin', async t => {
  const run = await runIdentity(t, {remote: true, mode: 'read-only'});
  assert.equal(run.exported.GOCACHEPROG_READ_ONLY, 'true');
});

test('packaged identity archives nothing when the plugin and a ready proxy cover both caches', async t => {
  const proxy = await moduleProxyStub(t, 200);
  const run = await runIdentity(t, {remote: true, proxy});
  assert.equal(run.outputs['module-proxy'], proxy);
  assert.equal(run.outputs.paths, '');
  assert.equal(run.outputs.key, '');
  assert.equal(run.exported.GOPROXY, proxy + '|https://proxy.golang.org,direct');
  assert.match(run.stdout, /modules: proxy http:\/\/127\.0\.0\.1:\d+/);
  assert.match(run.stdout, /manifests hashed: none, nothing is archived/);
});

test('packaged identity archives only build objects with a proxy and the GitHub build cache', async t => {
  const proxy = await moduleProxyStub(t, 200);
  const run = await runIdentity(t, {remote: false, proxy});
  assert.equal(run.outputs.paths, run.build);
  assert.match(run.outputs.key, /^go-v1-build-Linux-X64-go1\.26\.9-/);
});

test('packaged identity uses the bundle proxy inside a job container mount', async t => {
  const proxy = await moduleProxyStub(t, 200);
  const run = await runIdentity(t, {mounted: true, bundleProxy: proxy});
  assert.equal(run.outputs['module-proxy'], proxy);
  assert.equal(run.exported.GOPROXY, proxy + '|https://proxy.golang.org,direct');
  assert.equal(run.outputs.paths, '');
});

test('packaged identity skips a proxy that is not ready and archives modules', async t => {
  const proxy = await moduleProxyStub(t, 503);
  const run = await runIdentity(t, {remote: true, proxy});
  assert.equal(run.outputs['module-proxy'], '');
  assert.equal(run.outputs.paths, run.modules);
  assert.equal(run.exported.GOPROXY, undefined);
  assert.match(run.stdout, /::notice::The runner module proxy .* is not ready \(HTTP 503\)/);
});

test('packaged identity leaves a job-chosen GOPROXY alone', async t => {
  const proxy = await moduleProxyStub(t, 200);
  const run = await runIdentity(t, {remote: true, proxy, env: {GOPROXY: 'off'}});
  assert.equal(run.outputs['module-proxy'], '');
  assert.equal(run.exported.GOPROXY, undefined);
  assert.equal(run.outputs.paths, run.modules);
});

test('packaged identity archives and hashes nothing in off mode', async t => {
  const run = await runIdentity(t, {remote: false, mode: 'off'});
  assert.equal(run.outputs.backend, 'off');
  assert.equal(run.outputs.paths, '');
  assert.equal(run.outputs.key, '');
  assert.equal(run.outputs['restore-keys'], '');
  assert.match(run.stdout, /manifests hashed: none, nothing is archived/);
});

test('packaged identity hashes explicit patterns relative to the workspace', async t => {
  const run = await runIdentity(t, {remote: false, inputs: {'cache-dependency-path': 'sibling/go.sum'}});
  assert.match(run.outputs.key, new RegExp('-' + digest(['sibling/go.sum']) + '-123-1$'));
  assert.match(run.stdout, /manifests hashed: 1$/m);
});

test('packaged identity refuses manifest patterns outside the workspace even when nothing is archived', async t => {
  const proxy = await moduleProxyStub(t, 200);
  await assert.rejects(runIdentity(t, {remote: true, proxy, inputs: {'cache-dependency-path': '../go.sum'}}),
    /cache-dependency-path must stay inside the workspace/);
});
