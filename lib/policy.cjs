'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function input(name) { return process.env['INPUT_' + name.toUpperCase()] || ''; }
function output(name, value) {
  const delimiter = 'go_ci_' + crypto.randomUUID();
  fs.appendFileSync(process.env.GITHUB_OUTPUT, name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n');
}
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
  // Match the deployed helper so extraction restores existing warm caches.
  const workload = crypto.createHash('sha256')
    .update([values.workflow, values.job, values.workload].join('\n') + '\n').digest('hex').slice(0, 16);
  const platform = [values['cache-key-prefix'], values.os, values.arch, version].join('-') + '-';
  const base = platform + workload + '-';
  const dependencies = base + values['dependency-hash'] + '-';
  const key = dependencies + values['run-id'] + '-' + values['run-attempt'];
  if (key.length > 512) throw new Error('Cache key exceeds 512 characters');
  const restores = [dependencies, base];
  if (values['seed-from-other-workloads'] === 'true') restores.push(platform);
  return {key, 'restore-keys': restores.join('\n')};
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
module.exports = {identity, input, output, hours, validatePaths};
