'use strict';
const fs = require('node:fs');
const {measure, trim} = require('../lib/cache.cjs');
const {validatePaths, hours} = require('../lib/policy.cjs');
try {
  const state = JSON.parse(process.env.STATE_cache);
  validatePaths(state.build, state.modules);
  const started = Number(state['start-ms']);
  if (!Number.isSafeInteger(started) || started <= 0) throw new Error('Invalid setup start timestamp');
  const cutoff = started - hours(state['max-staleness-hours']) * 3600000;
  const began = Date.now();
  const build = state['cache-mode'] === 'read-write'
    ? trim(state.build, cutoff) : {...measure(state.build), removedBytes: 0, removedFiles: 0};
  const modules = measure(state.modules);
  const metrics = {mode: state['cache-mode'], restored: Boolean(state['matched-key']),
    buildBytes: build.bytes, moduleBytes: modules.bytes,
    removedBytes: build.removedBytes, removedFiles: build.removedFiles, maintenanceMs: Date.now() - began};
  console.log('Go cache metrics: ' + JSON.stringify(metrics));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const mib = value => (value / 1048576).toFixed(1) + ' MiB';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '\n### Go cache\n\n| Mode | Restored | Build | Modules | Trimmed | Maintenance |\n' +
      '| --- | --- | --- | --- | --- | --- |\n| ' + metrics.mode + ' | ' + metrics.restored +
      ' | ' + mib(metrics.buildBytes) + ' | ' + mib(metrics.moduleBytes) + ' | ' +
      mib(metrics.removedBytes) + ' | ' + metrics.maintenanceMs + ' ms |\n');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
