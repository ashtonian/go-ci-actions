'use strict';
const {execFileSync} = require('node:child_process');
const {buildCache, exportVariable, identity, input, output, validatePaths} = require('../lib/policy.cjs');
try {
  const started = Date.now();
  const go = JSON.parse(execFileSync('go', ['env', '-json', 'GOVERSION', 'GOCACHE', 'GOMODCACHE'], {encoding: 'utf8'}));
  const values = {};
  for (const name of ['workflow', 'job', 'workload', 'dependency-hash', 'os', 'arch',
    'run-id', 'run-attempt', 'cache-mode', 'cache-key-prefix', 'seed-from-other-workloads', 'max-staleness-hours']) {
    values[name] = input(name);
  }
  const cache = buildCache(input('build-cache-backend'), values['cache-mode'], process.env);
  const remote = cache.backend === 'remote';
  const result = identity({...values, backend: remote ? 'remote' : 'github'}, go.GOVERSION);
  const build = remote ? cache.dir : go.GOCACHE;
  if (values['cache-mode'] !== 'off') validatePaths(build, go.GOMODCACHE);
  for (const notice of cache.notices) console.log('::notice::' + notice);
  for (const [name, value] of Object.entries(cache.env)) exportVariable(name, value);
  for (const [name, value] of Object.entries({
    ...result, version: go.GOVERSION, build, modules: go.GOMODCACHE, backend: cache.backend,
    paths: remote ? go.GOMODCACHE : build + '\n' + go.GOMODCACHE, 'start-ms': String(started)
  })) output(name, value);
  console.log('Go cache mode: ' + values['cache-mode'] + '; build cache: ' + cache.backend +
    '; actual compiler: ' + go.GOVERSION);
} catch (error) { console.error(error.message); process.exitCode = 1; }
