'use strict';
const {input, output} = require('../lib/policy.cjs');
const {alreadyPassed, github, lookback, workflowFile} = require('../lib/history.cjs');
async function decide(env) {
  const names = input('jobs').split('\n').map(name => name.trim()).filter(Boolean);
  if (!names.length) throw new Error('jobs must name at least one job');
  const count = lookback(input('lookback') || '10');
  const get = github(env, input('token'));
  const {workflow_runs: runs} = await get('actions/workflows/' + encodeURIComponent(workflowFile(env)) + '/runs',
    {event: input('event'), branch: input('branch'), status: 'completed', per_page: String(count)});
  const earlier = runs.filter(run => String(run.id) !== env.GITHUB_RUN_ID);
  return alreadyPassed({runs: earlier, sha: env.GITHUB_SHA, names,
    jobsOf: async run => (await get('actions/runs/' + run.id + '/jobs', {filter: 'latest', per_page: '100'})).jobs});
}
async function main() {
  let result;
  try {
    result = await decide(process.env);
  } catch (error) {
    // Without evidence the work runs; a lookup failure never skips it.
    result = {passed: false, reason: 'history unavailable (' + error.message + ')'};
    console.log('::notice::' + result.reason + '; the jobs run');
  }
  output('passed', String(result.passed));
  output('reason', result.reason);
  console.log((result.passed ? 'already passed: ' : 'not passed yet: ') + result.reason);
}
main();
