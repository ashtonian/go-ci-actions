'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function input(name) { return process.env['INPUT_' + name.toUpperCase()] || ''; }
function append(file, name, value) {
  const delimiter = 'go_ci_' + crypto.randomUUID();
  fs.appendFileSync(file, name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n');
}
function output(name, value) { append(process.env.GITHUB_OUTPUT, name, value); }
function exportVariable(name, value) { append(process.env.GITHUB_ENV, name, value); }
function hours(raw) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > 8760) {
    throw new Error('max-staleness-hours must be a whole number from 0 through 8760');
  }
  return value;
}
function identity(values, version) {
  if (!['read-write', 'read-only', 'off'].includes(values['cache-mode'])) throw new Error('Invalid cache-mode');
  hours(values['max-staleness-hours']);
  if (!['true', 'false'].includes(values['seed-from-other-workloads'])) throw new Error('Invalid seed-from-other-workloads');
  for (const name of ['cache-key-prefix', 'os', 'arch', 'run-id', 'run-attempt']) {
    if (!/^[A-Za-z0-9._-]+$/.test(values[name] || '')) throw new Error('Invalid cache identity field: ' + name);
  }
  if (!/^go[0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error('Unsupported GOVERSION: ' + version);
  if (!/^[A-Fa-f0-9]*$/.test(values['dependency-hash'])) throw new Error('Invalid dependency hash');
  if (!['github', 'remote'].includes(values.backend)) throw new Error('Invalid build cache backend');
  if (!['archive', 'proxy'].includes(values.modules)) throw new Error('Invalid module source');
  // Match the deployed helper so extraction restores existing warm caches.
  const workload = crypto.createHash('sha256')
    .update([values.workflow, values.job, values.workload].join('\n') + '\n').digest('hex').slice(0, 16);
  // The plugin holds build objects and the proxy serves modules: nothing is archived.
  if (values.backend === 'remote' && values.modules === 'proxy') return {key: '', 'restore-keys': ''};
  if (values.backend === 'remote') {
    // Modules only. Their content is fixed by the manifests and not by the
    // compiler, so each workload saves once per manifest set.
    const platform = [values['cache-key-prefix'] + '-mod', values.os, values.arch].join('-') + '-';
    const base = platform + workload + '-';
    const key = base + values['dependency-hash'];
    if (key.length > 512) throw new Error('Cache key exceeds 512 characters');
    const restores = [base];
    if (values['seed-from-other-workloads'] === 'true') restores.push(platform);
    return {key, 'restore-keys': restores.join('\n')};
  }
  // An archive without modules gets its own namespace, so it never seeds, or
  // is seeded by, archives that carry the module cache.
  const namespace = values['cache-key-prefix'] + (values.modules === 'proxy' ? '-build' : '');
  const platform = [namespace, values.os, values.arch, version].join('-') + '-';
  const base = platform + workload + '-';
  const dependencies = base + values['dependency-hash'] + '-';
  const key = dependencies + values['run-id'] + '-' + values['run-attempt'];
  if (key.length > 512) throw new Error('Cache key exceeds 512 characters');
  const restores = [dependencies, base];
  if (values['seed-from-other-workloads'] === 'true') restores.push(platform);
  return {key, 'restore-keys': restores.join('\n')};
}
// Directories the GitHub cache archives: build objects unless the plugin holds
// them, modules unless the proxy serves them. Empty means no archive.
function archivePaths(backend, modules, buildDir, moduleDir) {
  const paths = [];
  if (backend === 'github') paths.push(buildDir);
  if (modules === 'archive') paths.push(moduleDir);
  return paths.join('\n');
}
function findExecutable(name, searchPath) {
  for (const dir of (searchPath || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  }
  return '';
}
// A runner-provided endpoint. It may end up in a GOPROXY list, where commas
// and pipes separate entries.
function serviceURL(name, value) {
  if (typeof value !== 'string' || /[\s,|]/.test(value)) throw new Error(name + ' must be a single HTTP(S) URL');
  let url;
  try { url = new URL(value); }
  catch { throw new Error(name + ' is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(name + ' must be HTTP(S) without credentials or a fragment');
  }
  return value;
}
// The runner-owned bundle under the tool cache: the gocacheprog executable and
// config.json naming the remote build cache, the module proxy and the npm
// registry cache, all optional.
function runnerBundle(env) {
  if (!env.RUNNER_TOOL_CACHE) return null;
  if (!path.isAbsolute(env.RUNNER_TOOL_CACHE)) throw new Error('RUNNER_TOOL_CACHE must be absolute');
  const dir = path.join(env.RUNNER_TOOL_CACHE, 'go-ci-cache', 'v1');
  const file = path.join(dir, 'config.json');
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid runner cache manifest');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid runner cache manifest JSON'); }
  if (!config || typeof config !== 'object' || config.version !== 1) throw new Error('Invalid runner cache manifest version');
  const bundle = {plugin: findExecutable('gocacheprog', dir), remoteURL: '', moduleProxyURL: '', npmRegistryURL: ''};
  if (config.remoteURL !== undefined) bundle.remoteURL = serviceURL('Runner cache remoteURL', config.remoteURL);
  if (config.moduleProxyURL !== undefined) {
    bundle.moduleProxyURL = serviceURL('Runner cache moduleProxyURL', config.moduleProxyURL);
  }
  if (config.npmRegistryURL !== undefined) {
    bundle.npmRegistryURL = serviceURL('Runner cache npmRegistryURL', config.npmRegistryURL);
  }
  return bundle;
}
// Job containers mount the runner's tool cache, but do not inherit its PATH
// or environment. The runner-owned bundle keeps the same cache contract there.
function buildCache(requested, mode, env) {
  if (!['auto', 'github'].includes(requested)) throw new Error('build-cache-backend must be auto or github');
  const result = {backend: mode === 'off' ? 'off' : 'github', env: {}, notices: []};
  if (env.GOCACHEPROG) result.env.GOCACHEPROG = '';
  if (mode === 'off' || requested === 'github') return result;
  let url = env.GOCACHEPROG_REMOTE_URL;
  let plugin = url ? findExecutable('gocacheprog', env.PATH) : '';
  if (!url || !plugin) {
    const mounted = runnerBundle(env);
    if (mounted) {
      url ||= mounted.remoteURL;
      plugin ||= mounted.plugin;
    }
  }
  if (!url) return result;
  if (!plugin) {
    result.notices.push('GOCACHEPROG_REMOTE_URL is set but gocacheprog is not on PATH or in the runner bundle; using the GitHub cache for build objects');
    return result;
  }
  const dir = env.GOCACHEPROG_DIR || (env.RUNNER_TEMP && path.join(env.RUNNER_TEMP, 'gocacheprog'));
  if (!dir) throw new Error('The remote build cache needs RUNNER_TEMP or GOCACHEPROG_DIR');
  result.backend = 'remote';
  result.dir = dir;
  result.env = {GOCACHEPROG: plugin, GOCACHEPROG_DIR: dir};
  if (!env.GOCACHEPROG_REMOTE_URL) result.env.GOCACHEPROG_REMOTE_URL = url;
  if (mode === 'read-only') result.env.GOCACHEPROG_READ_ONLY = 'true';
  else if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    result.notices.push('The job cannot request an OIDC token (permissions: id-token: write); the remote build cache is read-only');
  }
  return result;
}
const PROBE_TIMEOUT_MS = 3000;
async function probeHealth(url, healthPath) {
  try {
    const response = await fetch(url.replace(/\/+$/, '') + healthPath, {
      redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    await response.arrayBuffer();
    return response.ok ? {ready: true} : {ready: false, reason: 'HTTP ' + response.status};
  } catch (error) {
    return {ready: false, reason: (error.cause && error.cause.code) || error.message};
  }
}
// The runner's module proxy (GO_MODULE_PROXY_URL, or moduleProxyURL in the
// bundle) goes in front of the job's own GOPROXY list, joined by "|" so any
// proxy error falls through to that list. A job that sets GOPROXY keeps it.
// The proxy must answer /readyz: a dead one would sit in front of every module
// request of the job, so it is skipped and modules download as configured.
async function moduleProxy(requested, env, goProxy, probe = url => probeHealth(url, '/readyz')) {
  if (!['auto', 'off'].includes(requested)) throw new Error('module-proxy must be auto or off');
  const none = {url: '', env: {}, notices: []};
  if (requested === 'off' || env.GOPROXY) return none;
  let url = '';
  if (env.GO_MODULE_PROXY_URL) url = serviceURL('GO_MODULE_PROXY_URL', env.GO_MODULE_PROXY_URL);
  else url = (runnerBundle(env) || {}).moduleProxyURL || '';
  // go env reports off when the job's GOENV file forbids downloads.
  if (!url || goProxy === 'off') return none;
  const probed = await probe(url);
  if (!probed.ready) {
    return {...none, notices: ['The runner module proxy ' + url + ' is not ready (' + probed.reason +
      '); modules download as the job configures them']};
  }
  return {url, env: {GOPROXY: url + '|' + (goProxy || 'https://proxy.golang.org,direct')}, notices: []};
}
// The variables pnpm (pnpm_config_*, which pnpm 11 and later read instead of
// npm_config_*), npm and Corepack take a registry from.
const REGISTRY_VARIABLES = ['pnpm_config_registry', 'npm_config_registry', 'COREPACK_NPM_REGISTRY'];
// The runner's npm registry cache (NPM_REGISTRY_CACHE_URL, or npmRegistryURL in
// the bundle) becomes the job's registry when it answers /-/ping. pnpm and npm
// have no fallback registry, so a cache that does not answer is skipped and
// packages come from the registry the job already uses. A job that names a
// registry in its environment keeps it; scoped registries in .npmrc are
// unaffected either way.
async function npmRegistry(requested, env, probe = url => probeHealth(url, '/-/ping')) {
  if (!['auto', 'off'].includes(requested)) throw new Error('npm-registry mode must be auto or off');
  const none = {url: '', env: {}, notices: []};
  if (requested === 'off') return none;
  if (REGISTRY_VARIABLES.some(name => env[name] || env[name.toUpperCase()])) return none;
  let url = '';
  if (env.NPM_REGISTRY_CACHE_URL) url = serviceURL('NPM_REGISTRY_CACHE_URL', env.NPM_REGISTRY_CACHE_URL);
  else url = (runnerBundle(env) || {}).npmRegistryURL || '';
  if (!url) return none;
  const probed = await probe(url);
  if (!probed.ready) {
    return {...none, notices: ['The runner npm registry cache ' + url + ' is not ready (' + probed.reason +
      '); packages download from the registry the job configures']};
  }
  // npm and pnpm join package paths onto the registry URL, so it ends in a
  // slash; Corepack expects none.
  const base = url.replace(/\/+$/, '');
  return {
    url: base + '/',
    env: {pnpm_config_registry: base + '/', npm_config_registry: base + '/', COREPACK_NPM_REGISTRY: base},
    notices: []
  };
}
function validatePaths(build, modules) {
  const canonical = dir => {
    let current = path.resolve(dir);
    const missing = [];
    while (!fs.existsSync(current)) {
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
    return path.join(fs.realpathSync(current), ...missing);
  };
  const protectedPaths = [os.homedir(), process.env.GITHUB_WORKSPACE].filter(Boolean).map(canonical);
  const resolved = [];
  for (const dir of [build, modules]) {
    if (!path.isAbsolute(dir || '') || /[\r\n]/.test(dir)) throw new Error('Cache paths must be absolute single-line paths');
    const check = full => {
      if (full === path.parse(full).root || protectedPaths.some(p => p === full || p.startsWith(full + path.sep))) {
        throw new Error('Refusing broad cache directory: ' + full);
      }
    };
    check(canonical(dir));
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cache root must be a real directory');
      const real = fs.realpathSync(dir);
      check(real);
      resolved.push(real);
    } else {
      resolved.push(canonical(dir));
    }
  }
  const [a, b] = resolved;
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw new Error('Cache directories overlap');
}
module.exports = {
  archivePaths, buildCache, exportVariable, identity, input, moduleProxy, npmRegistry, output, hours, validatePaths
};
