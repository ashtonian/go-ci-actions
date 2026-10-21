'use strict';
const fs = require('node:fs');
const {input, validatePaths} = require('../lib/policy.cjs');
try {
  const state = {};
  for (const name of ['build', 'modules', 'start-ms', 'max-staleness-hours', 'cache-mode', 'backend', 'matched-key']) state[name] = input(name);
  validatePaths(state.build, state.modules);
  fs.appendFileSync(process.env.GITHUB_STATE, 'cache=' + JSON.stringify(state) + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }
