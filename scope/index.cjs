'use strict';
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {input, output} = require('../lib/policy.cjs');
const {github, workflowFile} = require('../lib/history.cjs');
const {SHA, decideBase, describeBuild, jobSelections, lines, matcher, parseBuilds, parseConfig, parseOwners, selectJobs,
  workflowJobs} = require('../lib/scope.cjs');
const {CLOSURE_FIELDS, LIST_FIELDS, affectedPackages, binaryClosure, byModule, importArgs, parseStream, rootDirs} =
  require('../lib/goaffected.cjs');
const GIT_TIMEOUT_MS = 120000;
const GO_TIMEOUT_MS = 600000;
const MAX_OUTPUT = 512 * 1024 * 1024;

function git(repo, args, options = {}) {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'], ...options});
}
// The checkout: path under the workspace, the workspace itself by default.
// A repository whose go.mod replaces siblings (../gox) is checked out in a
// subdirectory, with the siblings beside it.
function checkoutDir(workspace, relative) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('GITHUB_WORKSPACE must be an absolute path');
  const dir = path.resolve(workspace, relative || '.');
  const inside = path.relative(workspace, dir);
  if (inside.split(path.sep).includes('..') || path.isAbsolute(inside)) throw new Error('path must stay inside the workspace');
  return dir;
}
function headCommit(repo) {
  const sha = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const header = git(repo, ['cat-file', 'commit', sha]).split('\n\n', 1)[0];
  const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice('parent '.length));
  return {sha, parents};
}
// A shallow checkout lacks the base; fetch that one commit with the job
// token, through the environment so the token stays out of the process list.
function ensureCommit(repo, sha, env, token) {
  try { git(repo, ['cat-file', '-e', sha + '^{commit}']); return; } catch { /* fetched below */ }
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const auth = Buffer.from('x-access-token:' + token).toString('base64');
  git(repo, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha], {env: {...process.env,
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    // The empty value clears an extra header a persisted checkout credential added.
    GIT_CONFIG_KEY_0: 'http.' + server + '/.extraheader', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.' + server + '/.extraheader', GIT_CONFIG_VALUE_1: 'AUTHORIZATION: basic ' + auth}});
}
function changedFiles(repo, base) {
  return git(repo, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
}
function go(args, cwd, env = {}) {
  return execFileSync('go', args, {cwd, encoding: 'utf8', timeout: GO_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
}
// The workspace's Go package graph, loaded once and shared by every change
// set measured over this checkout: a push measures its own and the one its
// merge's pull request did over the same tree. A listing that failed fails
// again for each caller.
function goGraph({workspace: given, directory, builds}) {
  // go list reports resolved directories.
  const workspace = fs.realpathSync(given);
  const root = path.resolve(workspace, directory);
  if (!path.relative(workspace, root).split(path.sep).every(part => part !== '..')) {
    throw new Error('go-directory must stay inside the checkout');
  }
  const modules = parseStream(go(['list', '-m', '-json'], root));
  if (!modules.length) throw new Error('go list -m found no module in ' + directory);
  const listAll = (args, patterns) => {
    const entries = [];
    for (const build of builds) {
      const tagArgs = build.tags.length ? ['-tags', build.tags.join(',')] : [];
      entries.push(...parseStream(go(['list', '-e', ...args, ...tagArgs, ...patterns], root, build.env)));
    }
    return entries;
  };
  const memo = new Map();
  const once = (key, load) => {
    if (!memo.has(key)) {
      try { memo.set(key, {value: load()}); } catch (error) { memo.set(key, {error}); }
    }
    const loaded = memo.get(key);
    if (loaded.error) throw loaded.error;
    return loaded.value;
  };
  return {workspace, root, modules,
    // One package graph per build configuration, unioned.
    entries: () => once('packages', () => listAll(['-test', '-json=' + LIST_FIELDS], modules.map(module => module.Path + '/...'))),
    closure: job => once('binaries ' + job.id, () => binaryClosure(workspace, root, listAll(['-deps', '-json=' + CLOSURE_FIELDS], job.binaries)))};
}
// The affected Go packages for the changed files outside go-ignore, or every
// package when the change set is unknown (a full run, a shared input). A
// graph that does not load affects every package, with failed set: that is
// no measurement of what the change reaches.
function goScope(graph, {full, sharedFull, files, ignore, owners, jobs}) {
  const {workspace, root, modules} = graph;
  if (full || sharedFull) return {root, modules, result: {full: true, reason: full ? 'a full run' : 'a shared input changed'}};
  const changed = files.map(file => path.join(workspace, file));
  const considered = files.filter(file => !ignore(file)).map(file => path.join(workspace, file));
  let result = {full: false, reason: 'no Go input changed', packages: []}, binaries = {};
  try {
    if (considered.length) {
      const ownersOf = file => owners(path.relative(workspace, file).split(path.sep).join('/'))
        .map(dir => path.resolve(root, dir));
      result = affectedPackages({root, modules, entries: graph.entries(), changed: considered, exists: fs.existsSync,
        owners: ownersOf});
    }
    // A binary's closure is checked against every changed file, ignored ones
    // too: it may embed a document.
    if (!result.full) {
      for (const job of jobs.filter(candidate => candidate.binaries.length)) {
        const closure = graph.closure(job);
        const file = changed.find(candidate => closure.files.has(candidate));
        if (file) binaries[job.id] = 'the build of ' + job.binaries.join(', ') + ' reads ' + path.relative(workspace, file);
        else if (closure.broken) binaries[job.id] = 'the build of ' + job.binaries.join(', ') + ' does not load (' + closure.broken + ')';
      }
    }
  } catch (error) {
    // Without the package graph the change cannot be narrowed.
    const detail = (error.stderr || error.message || '').toString().trim().split('\n').slice(-3).join(' ');
    console.log('::warning::go list could not load the packages, so every package is affected: ' + detail);
    return {root, modules, result: {full: true, reason: 'go list failed', failed: true}};
  }
  return {root, modules, result, binaries};
}
// What a change set selects: the jobs, their packages and their selections.
// failed is set when the Go package graph did not load, so the selection is
// every package by default, not by measurement.
function measure({config, graph, full, files, ignore, owners}) {
  const sharedFull = !full && files.some(config.shared);
  let goResult = null, goPackages = {}, goArgs = '', failed = false;
  if (graph) {
    const scoped = goScope(graph, {full, sharedFull, files, ignore, owners, jobs: config.jobs});
    const dirs = scoped.result.full ? [] : rootDirs(scoped.root, scoped.result);
    goResult = {full: scoped.result.full, reason: scoped.result.reason, dirs, binaries: scoped.binaries || {},
      packages: scoped.result.full ? [] : scoped.result.packages.map((pkg, index) => ({importPath: pkg.importPath, dir: dirs[index]}))};
    goPackages = byModule(scoped.root, scoped.modules, scoped.result);
    goArgs = importArgs(scoped.modules, scoped.result).join(' ');
    failed = Boolean(scoped.result.failed);
  }
  const selection = selectJobs(config, {full, files, go: goResult});
  return {goResult, goPackages, goArgs, selection, failed, selections: jobSelections(config, selection, goResult)};
}
function writeFiles(env, files) {
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'go-ci-scope-'));
  const filesPath = path.join(dir, 'files');
  fs.writeFileSync(filesPath, files.map(file => file + '\n').join(''));
  return filesPath;
}
function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
async function main() {
  const env = process.env;
  const config = parseConfig(input('jobs'), input('shared'));
  if (!['', 'true', 'false'].includes(input('full'))) throw new Error('full must be true or false');
  const forceFull = input('full') === 'true';
  const lookback = Number(input('lookback') || '20');
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 100) throw new Error('lookback must be from 1 through 100');
  const ignore = matcher(lines(input('go-ignore')), 'go-ignore');
  const owners = parseOwners(input('go-owners'));
  const builds = parseBuilds(input('go-builds'), input('go-tags'));
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const token = input('token');
  const get = github(env, token);
  const workflow = input('workflow') || workflowFile(env);
  // The jobs live in jobsWorkflow, which differs from workflow when a
  // reusable workflow scopes its own jobs but its caller's runs are the
  // trunk history.
  const jobsWorkflow = input('jobs-workflow') || workflow;
  for (const [name, file] of [['workflow', workflow], ['jobs-workflow', jobsWorkflow]]) {
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) throw new Error(name + ' must be a file name under .github/workflows');
  }
  const repo = checkoutDir(env.GITHUB_WORKSPACE, input('path'));
  const defined = workflowJobs(fs.readFileSync(path.join(repo, '.github', 'workflows', jobsWorkflow), 'utf8'));
  const unknown = config.jobs.map(job => job.id).filter(id => !defined.has(id));
  if (unknown.length) throw new Error('jobs names IDs ' + jobsWorkflow + ' does not define: ' + unknown.join(', '));
  const head = headCommit(repo);
  const runsOf = async (file, branch) => (await get('actions/workflows/' + encodeURIComponent(file) + '/runs',
    {branch, status: 'success', exclude_pull_requests: 'true', per_page: String(lookback)})).workflow_runs;
  let decision;
  try {
    decision = await decideBase({eventName: env.GITHUB_EVENT_NAME, payload, env, head, forceFull,
      fullLabel: input('full-label'),
      greenRuns: async branch => runsOf(workflow, branch), scheduledRuns: async branch => runsOf(workflowFile(env), branch)});
  } catch (error) {
    decision = {full: true, reason: 'run history unavailable (' + error.message + ')'};
    console.log('::warning::' + decision.reason + '; every job runs');
  }
  let files = [];
  if (!decision.full) {
    try {
      if (!SHA.test(decision.base)) throw new Error('invalid base ' + decision.base);
      ensureCommit(repo, decision.base, env, token);
      files = changedFiles(repo, decision.base);
    } catch (error) {
      const detail = (error.stderr || error.message || '').toString().trim().split('\n').pop();
      decision = {full: true, reason: 'the diff against ' + decision.base + ' is unavailable (' + detail + ')'};
      console.log('::warning::' + decision.reason + '; every job runs');
    }
  }
  const graph = config.jobs.some(job => job.usesGo)
    ? goGraph({workspace: repo, directory: input('go-directory') || '.', builds}) : null;
  const measured = measure({config, graph, full: decision.full, files, ignore, owners});
  const {goResult, goPackages, goArgs, selection} = measured;
  const filesPath = decision.full ? '' : writeFiles(env, files);
  // The pull request that this push merges measured its change from the
  // merge's first parent over this same tree: measure that too, so acceptance
  // compares the push's selections with ones it computed, not with a record
  // any job of the pull request's run could have written. Its forced full
  // run or label made its run wider, never narrower, than this.
  let parentSelections = '', parentFilesPath = '', parentReason = '';
  if (env.GITHUB_EVENT_NAME === 'push' && head.parents.length === 2) {
    const parent = head.parents[0];
    try {
      let parentMeasured = measured, parentFiles = files;
      if (decision.full || decision.base !== parent) {
        ensureCommit(repo, parent, env, token);
        parentFiles = changedFiles(repo, parent);
        parentMeasured = measure({config, graph, full: false, files: parentFiles, ignore, owners});
      }
      if (parentMeasured.failed) {
        parentReason = 'the Go package graph did not load';
      } else {
        parentSelections = JSON.stringify(parentMeasured.selections);
        parentFilesPath = parentFiles === files && filesPath ? filesPath : writeFiles(env, parentFiles);
      }
    } catch (error) {
      parentReason = 'the diff against ' + parent + ' is unavailable (' +
        (error.stderr || error.message || '').toString().trim().split('\n').pop() + ')';
    }
    if (parentReason) console.log('::notice::No selections from the merge\'s parent: ' + parentReason);
  }
  const reason = decision.reason + (selection.shared ? '; the shared input ' + selection.shared + ' changed' : '');
  output('full', String(decision.full || Boolean(selection.shared)));
  output('jobs', JSON.stringify(selection.jobs));
  output('wide-jobs', JSON.stringify(selection.wide));
  output('selections', JSON.stringify(measured.selections));
  output('parent-selections', parentSelections);
  output('parent-files', parentFilesPath);
  output('base', decision.full ? '' : decision.base);
  output('files', filesPath);
  output('reason', reason);
  output('go-packages', JSON.stringify(goPackages));
  output('go-args', goArgs);
  output('go-reason', goResult ? goResult.reason : '');
  console.log('Scope: ' + reason);
  if (!decision.full) console.log(files.length + ' changed file(s)' + (files.length ? ':\n  ' + files.slice(0, 200).join('\n  ') : ''));
  for (const job of config.jobs) {
    const why = selection.why[job.id];
    const runs = selection.jobs.includes(job.id);
    const scope = runs && job.usesGo ? (selection.wide.includes(job.id) ? ', every package' : ', affected packages') : '';
    console.log('  ' + job.id + ': ' + (runs ? 'runs' + (why ? ' (' + why + scope + ')' : scope ? ' (' + scope.slice(2) + ')' : '') : 'skipped'));
  }
  if (goResult) {
    console.log('Go package graph: ' + builds.map(describeBuild).join('; '));
    console.log('Go packages (' + goResult.reason + '): ' + JSON.stringify(goPackages));
  }
  summary(['### Scope', '', reason + '.', '', 'Jobs: ' + (selection.jobs.join(', ') || 'none') + '.',
    ...(goResult ? ['', 'Go packages (' + goResult.reason + '): `' + JSON.stringify(goPackages) + '`'] : [])]);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
