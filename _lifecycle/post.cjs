'use strict';
const fs = require('node:fs');
const {measure, trim} = require('../lib/cache.cjs');
const {archived, validatePaths, hours} = require('../lib/policy.cjs');
try {
  const state = JSON.parse(process.env.STATE_cache);
  validatePaths(state.build, state.modules);
  const started = Number(state['start-ms']);
  if (!Number.isSafeInteger(started) || started <= 0) throw new Error('Invalid setup start timestamp');
  const cutoff = started - hours(state['max-staleness-hours']) * 3600000;
  const began = Date.now();
  const moduleSource = state['module-proxy'] ? 'proxy' : 'archive';
  // Only archived directories are walked: a remote backend's local plugin
  // directory or a proxied module cache can hold gigabytes nobody uploads.
  const archive = archived(state['cache-mode'], state.backend, moduleSource);
  const untouched = {bytes: null, removedBytes: 0, removedFiles: 0};
  let build = untouched;
  if (archive.build && state['cache-mode'] === 'read-write') build = trim(state.build, cutoff);
  else if (archive.build) build = {...measure(state.build), removedBytes: 0, removedFiles: 0};
  const modules = archive.modules ? measure(state.modules) : untouched;
  const metrics = {mode: state['cache-mode'], backend: state.backend, moduleSource,
    restored: Boolean(state['matched-key']), buildBytes: build.bytes, moduleBytes: modules.bytes,
    removedBytes: build.removedBytes, removedFiles: build.removedFiles, maintenanceMs: Date.now() - began};
  console.log('Go cache metrics: ' + JSON.stringify(metrics));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const mib = value => (value / 1048576).toFixed(1) + ' MiB';
    const size = value => (value === null ? 'not archived' : mib(value));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '\n### Go cache\n\n| Mode | Build cache | Modules from | Restored | Build | Modules | Trimmed | Maintenance |\n' +
      '| --- | --- | --- | --- | --- | --- | --- | --- |\n| ' + metrics.mode + ' | ' + metrics.backend + ' | ' +
      metrics.moduleSource + ' | ' + metrics.restored +
      ' | ' + size(metrics.buildBytes) + ' | ' + size(metrics.moduleBytes) + ' | ' +
      mib(metrics.removedBytes) + ' | ' + metrics.maintenanceMs + ' ms |\n');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
