'use strict';
const SHA = /^[0-9a-f]{40}$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Events whose successful runs on a branch prove its head green.
const TRUNK_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group']);
const FULL_EVENTS = new Set(['schedule', 'workflow_dispatch']);

// A repository path glob as a RegExp. `**` as a whole segment spans any
// number of directories, `*` and `?` stay within one segment, and everything
// else is literal. Dot files match like any other file.
function globRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.endsWith('/') ||
      pattern.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('invalid path glob: ' + JSON.stringify(pattern));
  }
  const segments = pattern.split('/');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    if (segment.includes('**')) throw new Error('** must be a whole path segment: ' + pattern);
    source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) source += '/';
  });
  return new RegExp('^' + source + '$');
}
function matcher(patterns) {
  const expressions = patterns.map(globRegExp);
  return file => expressions.some(expression => expression.test(file));
}
function lines(raw) {
  return (raw || '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}
// A Go package pattern relative to the Go root, matched against package
// directories ("." or "./a/b"): "./..." is every package, "./a/..." is a and
// everything under it, and "." or "./a" names one package.
function goPattern(pattern) {
  const recursive = typeof pattern === 'string' && pattern.endsWith('/...');
  const dir = recursive ? pattern.slice(0, -'/...'.length) : pattern;
  if (typeof dir !== 'string' || !(dir === '.' || /^\.(\/[^/\s]+)+$/.test(dir)) ||
      dir.split('/').slice(1).some(segment => segment === '.' || segment === '..' || segment === '...')) {
    throw new Error('invalid Go package pattern: ' + JSON.stringify(pattern) + ' (use ./..., ./dir/..., ./dir or .)');
  }
  if (dir === '.') return recursive ? () => true : candidate => candidate === '.';
  return recursive ? candidate => candidate === dir || candidate.startsWith(dir + '/') : candidate => candidate === dir;
}
// The scope configuration: each job's inputs as path globs, Go package
// patterns or both ({"lint": {"go": ["./..."]}, "image": {"paths":
// ["Dockerfile"], "go": ["./cmd/app"]}}; an array is shorthand for paths),
// and the shared inputs whose change selects every job.
function parseConfig(rawJobs, rawShared) {
  let jobs;
  try { jobs = JSON.parse(rawJobs); }
  catch (error) { throw new Error('jobs must be a JSON object of job ID to inputs: ' + error.message); }
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || !Object.keys(jobs).length) {
    throw new Error('jobs must be a JSON object naming at least one job');
  }
  const config = {jobs: [], shared: matcher(lines(rawShared))};
  for (const [id, raw] of Object.entries(jobs)) {
    if (!JOB_ID.test(id)) throw new Error('invalid job ID: ' + JSON.stringify(id));
    const spec = Array.isArray(raw) ? {paths: raw} : raw;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
        Object.keys(spec).some(key => key !== 'paths' && key !== 'go')) {
      throw new Error('job ' + id + ' must be an array of path globs or an object with paths and go');
    }
    const paths = spec.paths || [], go = spec.go || [];
    if (!Array.isArray(paths) || !Array.isArray(go) || !paths.length && !go.length) {
      throw new Error('job ' + id + ' needs at least one path glob or Go package pattern');
    }
    config.jobs.push({id, paths: matcher(paths), go: go.map(goPattern), usesGo: go.length > 0});
  }
  return config;
}
// The revision this run's changes are measured from, or why it runs
// unscoped. A pull request is measured from the base its merge commit
// merges into; a push from the head of the last green run of the workflow
// on its branch, so a cancelled or failed push never drops changes.
async function decideBase({eventName, payload, env, head, greenRuns, fullLabel, forceFull}) {
  if (forceFull) return {full: true, reason: 'a full run was requested'};
  if (FULL_EVENTS.has(eventName)) return {full: true, reason: 'a ' + eventName + ' run checks everything'};
  if (eventName === 'pull_request') {
    const pull = payload.pull_request || {};
    if (fullLabel && (pull.labels || []).some(label => label && label.name === fullLabel)) {
      return {full: true, reason: 'the pull request is labelled ' + fullLabel};
    }
    const merges = head.parents.length === 2 && head.parents[1] === (pull.head || {}).sha;
    const base = merges ? head.parents[0] : (pull.base || {}).sha;
    if (!SHA.test(base || '')) return {full: true, reason: 'the pull request event names no base commit'};
    return {full: false, base, reason: 'changes the pull request merges into ' + base.slice(0, 12)};
  }
  if (eventName === 'merge_group') {
    const base = (payload.merge_group || {}).base_sha;
    if (!SHA.test(base || '')) return {full: true, reason: 'the merge group names no base commit'};
    return {full: false, base, reason: 'changes the merge group adds to ' + base.slice(0, 12)};
  }
  if (eventName !== 'push') return {full: true, reason: 'a ' + eventName + ' event has no base to compare with'};
  const ref = env.GITHUB_REF || '';
  if (!ref.startsWith('refs/heads/')) return {full: true, reason: 'a push of ' + ref + ' checks everything'};
  const branch = ref.slice('refs/heads/'.length);
  const runs = await greenRuns(branch);
  const green = runs.find(run => String(run.id) !== env.GITHUB_RUN_ID && run.conclusion === 'success' &&
    run.head_branch === branch && TRUNK_EVENTS.has(run.event) && SHA.test(run.head_sha || '') &&
    (run.head_repository || {}).full_name === env.GITHUB_REPOSITORY);
  if (!green) return {full: true, reason: 'no green run of this workflow on ' + branch + ' to compare with'};
  return {full: false, base: green.head_sha, reason: 'changes since the last green run on ' + branch + ', ' + green.html_url};
}
// The jobs a change selects. A shared input selects every job, as does a
// full run; otherwise a job runs when one of its paths changed or one of
// its Go packages is affected (go is null when no job names packages).
// wide lists the selected jobs that check every package rather than the
// affected ones: a full run, a shared change, or one of the job's own paths
// (its configuration or scripts) changed.
function selectJobs(config, {full, files, go}) {
  const all = config.jobs.map(job => job.id);
  if (full) return {jobs: all, wide: all, why: {}};
  const shared = files.find(config.shared);
  if (shared) return {jobs: all, wide: all, why: {}, shared};
  const why = {}, wide = [];
  for (const job of config.jobs) {
    const file = files.find(job.paths);
    if (file) { why[job.id] = file; wide.push(job.id); continue; }
    if (!job.usesGo || !go) continue;
    if (go.full) { why[job.id] = 'every Go package (' + go.reason + ')'; continue; }
    const dir = go.dirs.find(candidate => job.go.some(test => test(candidate)));
    if (dir) why[job.id] = 'Go package ' + dir;
  }
  return {jobs: all.filter(id => why[id]), wide, why};
}
module.exports = {SHA, decideBase, globRegExp, goPattern, lines, matcher, parseConfig, selectJobs};
