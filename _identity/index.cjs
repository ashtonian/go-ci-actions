'use strict';
const {execFileSync} = require('node:child_process');
const {identity, input, output, validatePaths} = require('../lib/policy.cjs');
try {
  const started = Date.now();
  const go = JSON.parse(execFileSync('go', ['env', '-json', 'GOVERSION', 'GOCACHE', 'GOMODCACHE'], {encoding: 'utf8'}));
  const values = {};
  for (const name of ['workflow', 'job', 'workload', 'dependency-hash', 'os', 'arch',
    'run-id', 'run-attempt', 'cache-mode', 'cache-key-prefix', 'seed-from-other-workloads', 'max-staleness-hours']) {
    values[name] = input(name);
  }
  const result = identity(values, go.GOVERSION);
  if (values['cache-mode'] !== 'off') validatePaths(go.GOCACHE, go.GOMODCACHE);
  for (const [name, value] of Object.entries({
    ...result, version: go.GOVERSION, build: go.GOCACHE, modules: go.GOMODCACHE, 'start-ms': String(started)
  })) output(name, value);
  console.log('Go cache mode: ' + values['cache-mode'] + '; actual compiler: ' + go.GOVERSION);
} catch (error) { console.error(error.message); process.exitCode = 1; }
