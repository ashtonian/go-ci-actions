'use strict';
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {input, output} = require('../lib/policy.cjs');
const {buildCache, nodeCount} = require('../lib/buildcache.cjs');
try {
  const payload = process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const event = {
    name: process.env.GITHUB_EVENT_NAME || '',
    ref: process.env.GITHUB_REF || '',
    number: payload.pull_request ? payload.pull_request.number : undefined,
    defaultBranch: (payload.repository && payload.repository.default_branch) || ''
  };
  const platforms = input('platforms');
  let nodes = 1;
  if (platforms.split(/[\s,]+/).filter(Boolean).length > 1) {
    const builder = input('builder');
    nodes = nodeCount(execFileSync('docker', ['buildx', 'inspect', ...(builder ? [builder] : [])],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000}));
  }
  const cache = buildCache({registry: input('registry'), repository: input('repository'), scope: input('scope'),
    platforms, mode: input('mode'), nodes, event});
  output('cache-from', cache.cacheFrom.join('\n'));
  output('cache-to', cache.cacheTo);
  output('backend', cache.backend);
  console.log('BuildKit cache: ' + cache.backend + '; exports ' + cache.cacheTo.split(',')[1] +
    '; imports ' + cache.cacheFrom.map(e => e.split(',')[1]).join(', '));
} catch (error) {
  console.error('::error::buildx-cache: ' + error.message);
  process.exitCode = 1;
}
