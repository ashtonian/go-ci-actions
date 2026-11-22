'use strict';
const {input, output} = require('../lib/policy.cjs');
const {testInputMtimes} = require('../lib/mtimes.cjs');
try {
  const result = testInputMtimes({mode: input('mode'), cacheMode: input('cache-mode'),
    workspace: process.env.GITHUB_WORKSPACE, versionFile: input('go-version-file')});
  console.log((result.notice ? '::notice::' : '') + 'Test input mtimes: ' + result.message);
  output('state', result.state);
} catch (error) {
  console.error('Test input mtimes: ' + error.message + ' (test-input-mtimes: off leaves the checkout alone)');
  process.exitCode = 1;
}
