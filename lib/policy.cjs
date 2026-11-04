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
  // Match the deployed helper so extraction restores existing warm caches.
  const workload = crypto.createHash('sha256')
    .update([values.workflow, values.job, values.workload].join('\n') + '\n').digest('hex').slice(0, 16);
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
  const platform = [values['cache-key-prefix'], values.os, values.arch, version].join('-') + '-';
  const base = platform + workload + '-';
  const dependencies = base + values['dependency-hash'] + '-';
  const key = dependencies + values['run-id'] + '-' + values['run-attempt'];
  if (key.length > 512) throw new Error('Cache key exceeds 512 characters');
  const restores = [dependencies, base];
  if (values['seed-from-other-workloads'] === 'true') restores.push(platform);
  return {key, 'restore-keys': restores.join('\n')};
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
function mountedCache(env) {
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
  if (!config || config.version !== 1 || typeof config.remoteURL !== 'string' || /\s/.test(config.remoteURL)) {
    throw new Error('Invalid runner cache manifest version or remoteURL');
  }
  let url;
  try { url = new URL(config.remoteURL); }
  catch { throw new Error('Invalid runner cache remoteURL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Runner cache remoteURL must be HTTP(S) without credentials or a fragment');
  }
  return {url: config.remoteURL, plugin: findExecutable('gocacheprog', dir)};
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
    const mounted = mountedCache(env);
    if (mounted) {
      url ||= mounted.url;
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
module.exports = {buildCache, exportVariable, identity, input, output, hours, validatePaths};
