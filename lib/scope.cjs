'use strict';
const SHA = /^[0-9a-f]{40}$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Events whose successful runs on a branch prove its head green.
const TRUNK_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch', 'merge_group']);


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
// A scheduled run checks everything unless the last green scheduled run on
// the branch already did so on this commit. Those are runs of the workflow
// the schedule triggers (scheduledRuns), which calls this one when it is a
// reusable workflow; a push is measured from runs of this one (greenRuns).
async function decideBase({eventName, payload, env, head, greenRuns, scheduledRuns = greenRuns, fullLabel, forceFull}) {
  if (forceFull) return {full: true, reason: 'a full run was requested'};
  if (eventName === 'workflow_dispatch') return {full: true, reason: 'a workflow_dispatch run checks everything'};
  if (eventName === 'schedule') {
    const branch = (env.GITHUB_REF || '').replace(/^refs\/heads\//, '');
    const last = (await scheduledRuns(branch)).find(run => String(run.id) !== env.GITHUB_RUN_ID &&
      run.conclusion === 'success' && run.event === 'schedule' && run.head_branch === branch &&
      (run.head_repository || {}).full_name === env.GITHUB_REPOSITORY);
    if (last && last.head_sha === head.sha) {
      return {full: false, base: head.sha, reason: 'the last green scheduled run already checked ' + head.sha.slice(0, 12) + ', ' + last.html_url};
    }
    return {full: true, reason: 'a schedule run checks everything' + (last ? ' that changed since ' + last.html_url : '')};
  }
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
// The job IDs a workflow file defines: the keys indented one level under the
// top-level jobs mapping. A scope entry naming no job would leave that job
// never selected, so the caller refuses it.
function workflowJobs(text) {
  const ids = new Set();
  let inJobs = false, indent = '';
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inJobs = /^jobs:\s*(#.*)?$/.test(line); indent = ''; continue; }
    if (!inJobs || !line.trim() || /^\s*#/.test(line)) continue;
    const match = /^(\s+)([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
    if (!indent && match) indent = match[1];
    if (match && match[1] === indent) ids.add(match[2]);
  }
  return ids;
}
// go-owners: a JSON object of path glob to the Go package directories
// (relative to the Go root, "." or "./a") that read matching files at run
// time. The result maps a repository path to those directories.
function parseOwners(raw) {
  if (!raw || !raw.trim()) return () => [];
  let owners;
  try { owners = JSON.parse(raw); }
  catch (error) { throw new Error('go-owners must be a JSON object of path glob to package directories: ' + error.message); }
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) {
    throw new Error('go-owners must be a JSON object of path glob to package directories');
  }
  const rules = Object.entries(owners).map(([glob, dirs]) => {
    if (!Array.isArray(dirs) || !dirs.length || dirs.some(dir => typeof dir !== 'string' || dir.endsWith('/...'))) {
      throw new Error('go-owners ' + glob + ' must name package directories such as "." or "./a"');
    }
    dirs.forEach(goPattern);
    return {test: globRegExp(glob), dirs};
  });
  return file => [...new Set(rules.filter(rule => rule.test.test(file)).flatMap(rule => rule.dirs))];
}
// go-builds: one build configuration per line, as KEY=VALUE pairs from a
// fixed set of go environment keys plus tags=a,b. Each configuration's
// package graph is loaded and the graphs are unioned, so a package that
// builds only for one GOOS or tag set is still owned and its dependents
// found. common is go-tags, added to every configuration. No lines is one
// configuration: the runner's own platform with common.
const BUILD_KEYS = new Set(['GOOS', 'GOARCH', 'GOARM', 'GOAMD64', 'GOARM64', 'CGO_ENABLED', 'GOEXPERIMENT', 'tags']);
function parseBuilds(raw, common) {
  const tagList = value => value.split(/[\s,]+/).filter(Boolean);
  const builds = lines(raw).map(line => {
    const build = {env: {}, tags: tagList(common || '')};
    for (const pair of line.split(/\s+/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_.,-]*)$/.exec(pair);
      if (!match || !BUILD_KEYS.has(match[1])) {
        throw new Error('go-builds: ' + JSON.stringify(pair) + ' is not one of ' + [...BUILD_KEYS].join(', ') + ' as KEY=VALUE');
      }
      if (match[1] === 'tags') build.tags.push(...tagList(match[2]));
      else build.env[match[1]] = match[2];
    }
    build.tags = [...new Set(build.tags)];
    return build;
  });
  return builds.length ? builds : [{env: {}, tags: [...new Set(tagList(common || ''))]}];
}
function describeBuild(build) {
  return [...Object.entries(build.env).map(([key, value]) => key + '=' + value),
    ...(build.tags.length ? ['tags=' + build.tags.join(',')] : [])].join(' ') || 'the runner platform';
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
module.exports = {SHA, decideBase, describeBuild, globRegExp, goPattern, lines, matcher, parseBuilds, parseConfig, parseOwners,
  selectJobs, workflowJobs};
