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
// The runner provides a remote build cache by setting GOCACHEPROG_REMOTE_URL
// and installing gocacheprog. This action owns GOCACHEPROG for the job, so a
// value inherited from the runner is cleared unless the remote backend is used.
function buildCache(requested, mode, env) {
  if (!['auto', 'github'].includes(requested)) throw new Error('build-cache-backend must be auto or github');
  const result = {backend: mode === 'off' ? 'off' : 'github', env: {}, notices: []};
  if (env.GOCACHEPROG) result.env.GOCACHEPROG = '';
  if (mode === 'off' || requested === 'github' || !env.GOCACHEPROG_REMOTE_URL) return result;
  const plugin = findExecutable('gocacheprog', env.PATH);
  if (!plugin) {
    result.notices.push('GOCACHEPROG_REMOTE_URL is set but gocacheprog is not on PATH; using the GitHub cache for build objects');
    return result;
  }
  const dir = env.GOCACHEPROG_DIR || (env.RUNNER_TEMP && path.join(env.RUNNER_TEMP, 'gocacheprog'));
  if (!dir) throw new Error('The remote build cache needs RUNNER_TEMP or GOCACHEPROG_DIR');
  result.backend = 'remote';
  result.dir = dir;
  result.env = {GOCACHEPROG: plugin, GOCACHEPROG_DIR: dir};
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
