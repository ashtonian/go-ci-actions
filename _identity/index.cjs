'use strict';
const {execFileSync} = require('node:child_process');
const {archivePaths, buildCache, exportVariable, identity, input, moduleProxy, output, validatePaths} =
  require('../lib/policy.cjs');
async function main() {
  const started = Date.now();
  const go = JSON.parse(execFileSync('go', ['env', '-json', 'GOVERSION', 'GOCACHE', 'GOMODCACHE', 'GOPROXY'],
    {encoding: 'utf8'}));
  const values = {};
  for (const name of ['workflow', 'job', 'workload', 'dependency-hash', 'os', 'arch',
    'run-id', 'run-attempt', 'cache-mode', 'cache-key-prefix', 'seed-from-other-workloads', 'max-staleness-hours']) {
    values[name] = input(name);
  }
  const cache = buildCache(input('build-cache-backend'), values['cache-mode'], process.env);
  const proxy = await moduleProxy(input('module-proxy'), process.env, go.GOPROXY);
  const backend = cache.backend === 'remote' ? 'remote' : 'github';
  const modules = proxy.url ? 'proxy' : 'archive';
  const result = identity({...values, backend, modules}, go.GOVERSION);
  const build = backend === 'remote' ? cache.dir : go.GOCACHE;
  if (values['cache-mode'] !== 'off') validatePaths(build, go.GOMODCACHE);
  for (const notice of [...cache.notices, ...proxy.notices]) console.log('::notice::' + notice);
  for (const [name, value] of Object.entries({...cache.env, ...proxy.env})) exportVariable(name, value);
  for (const [name, value] of Object.entries({
    ...result, version: go.GOVERSION, build, modules: go.GOMODCACHE, backend: cache.backend,
    paths: archivePaths(backend, modules, build, go.GOMODCACHE), 'module-proxy': proxy.url,
    'start-ms': String(started)
  })) output(name, value);
  console.log('Go cache mode: ' + values['cache-mode'] + '; build cache: ' + cache.backend +
    '; modules: ' + (proxy.url ? 'proxy ' + proxy.url : 'archive') + '; actual compiler: ' + go.GOVERSION);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
