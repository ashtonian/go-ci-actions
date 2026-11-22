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
// Earlier completed runs, newest first, decide: the first run on another
// commit ends the search, because the jobs then have something new to check;
// a run that skipped every named job says nothing either way; otherwise the
// newest run that ran them passed only if each of them succeeded.
async function alreadyPassed({runs, sha, names, jobsOf}) {
  for (const run of runs) {
    if (run.head_sha !== sha) return {passed: false, reason: 'the commit changed since ' + run.html_url};
    const ran = (await jobsOf(run)).filter(job => matches(job, names) && job.conclusion !== 'skipped');
    if (!ran.length) continue;
    if (ran.every(job => job.conclusion === 'success')) {
      return {passed: true, reason: 'they passed on ' + sha + ' in ' + run.html_url};
    }
    return {passed: false, reason: 'they did not all pass on ' + sha + ' in ' + run.html_url};
  }
  return {passed: false, reason: 'no earlier run on ' + sha + ' within the lookback ran them'};
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
