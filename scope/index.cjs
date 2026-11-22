'use strict';
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {input, output} = require('../lib/policy.cjs');
const {github, workflowFile} = require('../lib/history.cjs');
const {SHA, decideBase, lines, matcher, parseConfig, selectJobs} = require('../lib/scope.cjs');
const {LIST_FIELDS, affectedPackages, byModule, parseStream, rootDirs} = require('../lib/goaffected.cjs');
const GIT_TIMEOUT_MS = 120000;
const GO_TIMEOUT_MS = 600000;
const MAX_OUTPUT = 512 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync('git', args, {encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'], ...options});
}
function headCommit() {
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const header = git(['cat-file', 'commit', sha]).split('\n\n', 1)[0];
  const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice('parent '.length));
  return {sha, parents};
}
// A shallow checkout lacks the base; fetch that one commit with the job
// token, through the environment so the token stays out of the process list.
function ensureCommit(sha, env, token) {
  try { git(['cat-file', '-e', sha + '^{commit}']); return; } catch { /* fetched below */ }
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const auth = Buffer.from('x-access-token:' + token).toString('base64');
  git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha], {env: {...process.env,
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    // The empty value clears an extra header a persisted checkout credential added.
    GIT_CONFIG_KEY_0: 'http.' + server + '/.extraheader', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.' + server + '/.extraheader', GIT_CONFIG_VALUE_1: 'AUTHORIZATION: basic ' + auth}});
}
function changedFiles(base) {
  return git(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
}
function go(args, cwd) {
  return execFileSync('go', args, {cwd, encoding: 'utf8', timeout: GO_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe']});
}
// The affected Go packages for the changed files outside go-ignore, or every
// package when the change set is unknown (a full run, a shared input).
function goScope({full, sharedFull, files, workspace: given, directory, tags, ignore}) {
  // go list reports resolved directories.
  const workspace = fs.realpathSync(given);
  const root = path.resolve(workspace, directory);
  if (!path.relative(workspace, root).split(path.sep).every(part => part !== '..')) {
    throw new Error('go-directory must stay inside the workspace');
  }
  const modules = parseStream(go(['list', '-m', '-json'], root));
  if (!modules.length) throw new Error('go list -m found no module in ' + directory);
  if (full || sharedFull) return {root, modules, result: {full: true, reason: full ? 'a full run' : 'a shared input changed'}};
  const considered = files.filter(file => !ignore(file)).map(file => path.join(workspace, file));
  if (!considered.length) return {root, modules, result: {full: false, reason: 'no Go input changed', packages: []}};
  const tagArgs = tags ? ['-tags', tags] : [];
  let entries;
  try {
    entries = parseStream(go(['list', '-e', '-test', '-json=' + LIST_FIELDS, ...tagArgs,
      ...modules.map(module => module.Path + '/...')], root));
  } catch (error) {
    // Without the package graph the change cannot be narrowed.
    const detail = (error.stderr || error.message || '').toString().trim().split('\n').slice(-3).join(' ');
    console.log('::warning::go list could not load the packages, so every package is affected: ' + detail);
    return {root, modules, result: {full: true, reason: 'go list failed'}};
  }
  return {root, modules, result: affectedPackages({root, modules, entries, changed: considered, exists: fs.existsSync})};
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
  const ignore = matcher(lines(input('go-ignore')));
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const token = input('token');
  const get = github(env, token);
  const workflow = input('workflow') || workflowFile(env);
  const head = headCommit();
  let decision;
  try {
    decision = await decideBase({eventName: env.GITHUB_EVENT_NAME, payload, env, head, forceFull,
      fullLabel: input('full-label'),
      greenRuns: async branch => (await get('actions/workflows/' + encodeURIComponent(workflow) + '/runs',
        {branch, status: 'success', exclude_pull_requests: 'true', per_page: String(lookback)})).workflow_runs});
  } catch (error) {
    decision = {full: true, reason: 'run history unavailable (' + error.message + ')'};
    console.log('::warning::' + decision.reason + '; every job runs');
  }
  let files = [];
  if (!decision.full) {
    try {
      if (!SHA.test(decision.base)) throw new Error('invalid base ' + decision.base);
      ensureCommit(decision.base, env, token);
      files = changedFiles(decision.base);
    } catch (error) {
      const detail = (error.stderr || error.message || '').toString().trim().split('\n').pop();
      decision = {full: true, reason: 'the diff against ' + decision.base + ' is unavailable (' + detail + ')'};
      console.log('::warning::' + decision.reason + '; every job runs');
    }
  }
  const sharedFull = !decision.full && files.some(config.shared);
  let goResult = null, goPackages = {};
  if (config.jobs.some(job => job.usesGo)) {
    const scoped = goScope({full: decision.full, sharedFull, files, workspace: env.GITHUB_WORKSPACE,
      directory: input('go-directory') || '.', tags: input('go-tags'), ignore});
    goResult = {full: scoped.result.full, reason: scoped.result.reason,
      dirs: scoped.result.full ? [] : rootDirs(scoped.root, scoped.result)};
    goPackages = byModule(scoped.root, scoped.modules, scoped.result);
  }
  const selection = selectJobs(config, {full: decision.full, files, go: goResult});
  let filesPath = '';
  if (!decision.full) {
    const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'go-ci-scope-'));
    filesPath = path.join(dir, 'files');
    fs.writeFileSync(filesPath, files.map(file => file + '\n').join(''));
  }
  const reason = decision.reason + (selection.shared ? '; the shared input ' + selection.shared + ' changed' : '');
  output('full', String(decision.full || Boolean(selection.shared)));
  output('jobs', JSON.stringify(selection.jobs));
  output('wide-jobs', JSON.stringify(selection.wide));
  output('base', decision.full ? '' : decision.base);
  output('files', filesPath);
  output('reason', reason);
  output('go-packages', JSON.stringify(goPackages));
  output('go-reason', goResult ? goResult.reason : '');
  console.log('Scope: ' + reason);
  if (!decision.full) console.log(files.length + ' changed file(s)' + (files.length ? ':\n  ' + files.slice(0, 200).join('\n  ') : ''));
  for (const job of config.jobs) {
    const why = selection.why[job.id];
    const runs = selection.jobs.includes(job.id);
    const scope = runs && job.usesGo ? (selection.wide.includes(job.id) ? ', every package' : ', affected packages') : '';
    console.log('  ' + job.id + ': ' + (runs ? 'runs' + (why ? ' (' + why + scope + ')' : scope ? ' (' + scope.slice(2) + ')' : '') : 'skipped'));
  }
  if (goResult) console.log('Go packages (' + goResult.reason + '): ' + JSON.stringify(goPackages));
  summary(['### Scope', '', reason + '.', '', 'Jobs: ' + (selection.jobs.join(', ') || 'none') + '.',
    ...(goResult ? ['', 'Go packages (' + goResult.reason + '): `' + JSON.stringify(goPackages) + '`'] : [])]);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
