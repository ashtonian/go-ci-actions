'use strict';
const API_TIMEOUT_MS = 10000;
const MAX_LOOKBACK = 50;
// The workflow file of the running workflow, from GITHUB_WORKFLOW_REF
// ("owner/repo/.github/workflows/nightly.yml@refs/heads/main").
function workflowFile(env) {
  const prefix = env.GITHUB_REPOSITORY + '/';
  const ref = env.GITHUB_WORKFLOW_REF || '';
  const file = ref.startsWith(prefix) ? ref.slice(prefix.length).split('@')[0] : '';
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(file)) {
    throw new Error('GITHUB_WORKFLOW_REF does not name a workflow of this repository');
  }
  return file.slice('.github/workflows/'.length);
}
function lookback(raw) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_LOOKBACK) {
    throw new Error('lookback must be a whole number from 1 through ' + MAX_LOOKBACK);
  }
  return value;
}
// A job named exactly, one of its matrix variants ("name (variant)"), or,
// for a job that calls a reusable workflow, any job it calls ("name / job").
function matches(job, names) {
  return names.some(name => job.name === name || job.name.startsWith(name + ' (') || job.name.startsWith(name + ' / '));
}
// Earlier completed runs, newest first, decide each name on its own: the
// first run on another commit ends the search, because the jobs then have
// something new to check; a run that skipped a name's jobs says nothing about
// it; otherwise the newest run that ran a name's jobs passed it only if each
// of them succeeded. A run that ran some of the names vouches for those only.
async function alreadyPassed({runs, sha, names, jobsOf}) {
  const results = {};
  const undecided = () => names.filter(name => !(name in results));
  let ended = 'no earlier run on ' + sha + ' within the lookback ran it';
  for (const run of runs) {
    if (run.head_sha !== sha) {
      ended = 'the commit changed since ' + run.html_url;
      break;
    }
    const jobs = await jobsOf(run);
    for (const name of undecided()) {
      const ran = jobs.filter(job => matches(job, [name]) && job.conclusion !== 'skipped');
      if (!ran.length) continue;
      results[name] = ran.every(job => job.conclusion === 'success')
        ? {passed: true, reason: 'passed on ' + sha + ' in ' + run.html_url}
        : {passed: false, reason: 'did not pass on ' + sha + ' in ' + run.html_url};
    }
    if (!undecided().length) break;
  }
  for (const name of undecided()) results[name] = {passed: false, reason: ended};
  const passed = names.every(name => results[name].passed);
  const reason = names.map(name => name + ': ' + results[name].reason).join('; ');
  return {passed, reason, passedJobs: names.filter(name => results[name].passed)};
}
function github(env, token) {
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '') + '/repos/' + env.GITHUB_REPOSITORY + '/';
  return async (path, query) => {
    const response = await fetch(base + path + '?' + new URLSearchParams(query), {
      headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + token},
      redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error('GET ' + path + ': HTTP ' + response.status);
    return response.json();
  };
}
module.exports = {alreadyPassed, github, lookback, matches, workflowFile};
