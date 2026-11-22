'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {decideBase, describeBuild, globRegExp, goPattern, matcher, parseBuilds, parseConfig, parseOwners, selectJobs, workflowJobs} =
  require('../lib/scope.cjs');

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), H = 'd'.repeat(40);

test('globs: ** spans directories, * and ? stay in one segment, dots match', () => {
  const cases = [
    ['**/*.go', ['a.go', 'x/y/a.go', '.hidden/a.go'], ['a.go.txt', 'a.mod']],
    ['docs/**', ['docs/a.md', 'docs/x/y.png'], ['docs', 'README.md', 'x/docs/a.md']],
    ['a/**/b', ['a/b', 'a/x/b', 'a/x/y/b'], ['a/xb', 'b']],
    ['go.work*', ['go.work', 'go.work.sum'], ['x/go.work']],
    ['.github/workflows/ci.yml', ['.github/workflows/ci.yml'], ['.github/workflows/ci.yaml']],
    ['cmd/?/main.go', ['cmd/a/main.go'], ['cmd/ab/main.go']],
    ['**', ['a', 'a/b/c'], []],
    ['a+b(c)[d].txt', ['a+b(c)[d].txt'], ['aab(c)d.txt']],
  ];
  for (const [pattern, yes, no] of cases) {
    const re = globRegExp(pattern);
    for (const file of yes) assert.ok(re.test(file), pattern + ' should match ' + file);
    for (const file of no) assert.ok(!re.test(file), pattern + ' should not match ' + file);
  }
  for (const bad of ['', '/abs', 'dir/', './a', 'a/../b', 'a//b', 'a**', 'x/**y', 7]) {
    assert.throws(() => globRegExp(bad), /glob|segment/, String(bad));
  }
});

test('a "!" glob excludes what the other globs include, wherever it appears', () => {
  // karsto's scopes: karsto/** without the web app, docs, tests and testdata.
  const karsto = matcher(['karsto/**', '!karsto/web/**', '!**/*.md', '!**/*_test.go', '!**/testdata/**']);
  for (const file of ['karsto/main.go', 'karsto/pkg/x/y.go']) assert.ok(karsto(file), file);
  for (const file of ['karsto/web/app.ts', 'karsto/README.md', 'karsto/pkg/x_test.go', 'karsto/pkg/testdata/a.json', 'other/main.go']) {
    assert.ok(!karsto(file), file);
  }
  assert.ok(matcher(['!docs/**', '**'])('src/a.go'), 'order does not matter');
  assert.ok(!matcher(['!docs/**', '**'])('docs/a.md'));
  assert.throws(() => matcher(['!**/*.md'], 'job docs'), /job docs has "!" excludes but nothing to include/);
  assert.throws(() => matcher(['!/abs', 'a']), /glob/);
  const config = parseConfig(JSON.stringify({go: {paths: ['karsto/**', '!karsto/web/**'], go: ['./...']}}), '.github/**\n!.github/ISSUE_TEMPLATE/**\n');
  assert.ok(config.jobs[0].paths('karsto/a.go') && !config.jobs[0].paths('karsto/web/a.ts'));
  assert.ok(config.shared('.github/workflows/ci.yml') && !config.shared('.github/ISSUE_TEMPLATE/bug.md'));
  assert.throws(() => parseConfig(JSON.stringify({go: {paths: ['!karsto/web/**'], go: ['./...']}}), ''), /job go has "!" excludes/);
});

test('Go package patterns match package directories', () => {
  const all = goPattern('./...'), cmd = goPattern('./cmd/...'), one = goPattern('./cmd/app'), root = goPattern('.');
  assert.ok(all('.') && all('./x/y'));
  assert.ok(cmd('./cmd') && cmd('./cmd/app') && !cmd('./cmdx') && !cmd('.'));
  assert.ok(one('./cmd/app') && !one('./cmd/app/sub'));
  assert.ok(root('.') && !root('./a'));
  for (const bad of ['...', 'cmd/app', './', './a/../b', '/abs', './a b', '']) assert.throws(() => goPattern(bad), /Go package pattern/, bad);
});

test('the configuration is validated', () => {
  const config = parseConfig('{"lint": ["**/*.go"], "image": {"paths": ["Dockerfile"], "go": ["./cmd/app"]}, "test": {"go": ["./..."]}}',
    '# shared\n.github/workflows/ci.yml\n\nscripts/**\n');
  assert.deepEqual(config.jobs.map(job => [job.id, job.usesGo]), [['lint', false], ['image', true], ['test', true]]);
  assert.ok(config.shared('scripts/x.sh') && !config.shared('README.md'));
  for (const raw of ['', '[]', '{}', 'nope', '{"bad id": ["a"]}', '{"a": []}', '{"a": {"paths": []}}',
    '{"a": {"other": ["x"]}}', '{"a": "x"}', '{"a": ["/abs"]}', '{"a": {"go": ["cmd"]}}']) {
    assert.throws(() => parseConfig(raw, ''), Error, raw);
  }
});

test('the job IDs of a workflow file are its top-level jobs keys', () => {
  const text = ['name: ci', 'on:', '  push:', 'env:', '  lint: x', 'jobs:', '  # a comment', '  scope:', '    runs-on: x',
    '    steps:', '      - id: lint', '  test: # tests', '    needs: scope', '  build-and-scan:', 'other:', '  late:'].join('\n');
  assert.deepEqual([...workflowJobs(text)], ['scope', 'test', 'build-and-scan']);
  assert.deepEqual([...workflowJobs('jobs:\n    a:\n      b:\n    c:\n')], ['a', 'c']);
});

test('the build configurations are every go-builds line with every go-tags tag set', () => {
  assert.deepEqual(parseBuilds('', 'conformance e2e smoke'), [{env: {}, tags: ['conformance', 'e2e', 'smoke']}],
    'one go-tags line is one tag set');
  assert.deepEqual(parseBuilds('', ''), [{env: {}, tags: []}]);
  const builds = parseBuilds('# platforms\nGOOS=linux GOARCH=amd64\nGOOS=windows tags=slow\n', '-\nunit\nunit,integration\n');
  assert.deepEqual(builds, [
    {env: {GOOS: 'linux', GOARCH: 'amd64'}, tags: []},
    {env: {GOOS: 'linux', GOARCH: 'amd64'}, tags: ['unit']},
    {env: {GOOS: 'linux', GOARCH: 'amd64'}, tags: ['unit', 'integration']},
    {env: {GOOS: 'windows'}, tags: ['slow']},
    {env: {GOOS: 'windows'}, tags: ['slow', 'unit']},
    {env: {GOOS: 'windows'}, tags: ['slow', 'unit', 'integration']},
  ]);
  assert.equal(describeBuild(builds[5]), 'GOOS=windows tags=slow,unit,integration');
  assert.equal(describeBuild({env: {}, tags: []}), 'the runner platform');
  for (const bad of ['GOFLAGS=-mod=mod', 'GOOS', 'goos=linux', 'GOOS=linux;rm', 'PATH=/tmp']) {
    assert.throws(() => parseBuilds(bad, ''), /go-builds/, bad);
  }
  assert.throws(() => parseBuilds('', 'unit;rm'), /go-tags/);
});

test('go-owners maps globs to the packages that read them', () => {
  const owners = parseOwners('{"docs/*.md": [".", "./examples/readme"], "README.md": ["./examples/readme"]}');
  assert.deepEqual(owners('docs/guide.md'), ['.', './examples/readme']);
  assert.deepEqual(owners('README.md'), ['./examples/readme']);
  assert.deepEqual(owners('docs/x/y.md'), []);
  assert.deepEqual(parseOwners('')('a'), []);
  for (const raw of ['[]', 'x', '{"a": []}', '{"a": ["./..."]}', '{"a": ["dir"]}', '{"/a": ["."]}', '{"a": "."}']) {
    assert.throws(() => parseOwners(raw), Error, raw);
  }
});

const env = {GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9', GITHUB_REF: 'refs/heads/main'};
const greenRun = (id, fields = {}) => ({id, conclusion: 'success', head_branch: 'main', event: 'push', head_sha: A,
  head_repository: {full_name: 'o/r'}, html_url: 'https://github.com/o/r/actions/runs/' + id, ...fields});
function base(eventName, payload = {}, fields = {}) {
  return decideBase({eventName, payload, env: {...env, ...fields.env}, head: fields.head || {sha: H, parents: [B]},
    greenRuns: fields.greenRuns || (async () => { throw new Error('history must not be read'); }),
    fullLabel: 'full-ci', forceFull: fields.forceFull || false});
}

test('a pull request is measured from the base its merge commit merges into', async () => {
  const pull = {pull_request: {head: {sha: C}, base: {sha: A}, labels: [{name: 'docs'}]}};
  assert.deepEqual(await base('pull_request', pull, {head: {sha: H, parents: [B, C]}}),
    {full: false, base: B, reason: 'changes the pull request merges into ' + B.slice(0, 12)});
  // A checkout of the head instead of the merge falls back to the event's base:
  // a superset of the change, never less.
  assert.equal((await base('pull_request', pull, {head: {sha: C, parents: [A]}})).base, A);
  const labelled = {pull_request: {...pull.pull_request, labels: [{name: 'full-ci'}]}};
  assert.equal((await base('pull_request', labelled, {head: {sha: H, parents: [B, C]}})).full, true);
  assert.equal((await base('pull_request', {pull_request: {head: {sha: C}}}, {head: {sha: C, parents: [A]}})).full, true);
});

test('a push is measured from the newest green run on its branch', async () => {
  const runs = [
    greenRun(9, {head_sha: C}),
    greenRun(8, {head_branch: 'other'}),
    greenRun(7, {event: 'pull_request'}),
    greenRun(6, {head_repository: {full_name: 'fork/r'}}),
    greenRun(5, {conclusion: 'failure'}),
    greenRun(4, {head_sha: B, event: 'schedule'}),
    greenRun(3),
  ];
  let asked;
  const result = await base('push', {}, {greenRuns: async branch => { asked = branch; return runs; }});
  assert.equal(asked, 'main');
  assert.equal(result.full, false);
  assert.equal(result.base, B, 'the current run, other branches, pull requests, forks and failures are passed over');
  assert.match(result.reason, /runs\/4$/);
  assert.equal((await base('push', {}, {greenRuns: async () => []})).full, true);
  assert.equal((await base('push', {}, {env: {GITHUB_REF: 'refs/tags/v1'}})).full, true);
});

test('scheduled, dispatched and requested runs check everything', async () => {
  for (const name of ['workflow_dispatch', 'release']) assert.equal((await base(name)).full, true, name);
  assert.equal((await base('schedule', {}, {greenRuns: async () => []})).full, true);
  assert.equal((await base('push', {}, {forceFull: true})).full, true);
  assert.deepEqual(await base('merge_group', {merge_group: {base_sha: A}}),
    {full: false, base: A, reason: 'changes the merge group adds to ' + A.slice(0, 12)});
});

test('a scheduled run skips a commit the last green scheduled run checked', async () => {
  const runs = [greenRun(9, {event: 'schedule', head_sha: H}), greenRun(8, {head_sha: H}),
    greenRun(7, {event: 'schedule', head_sha: H, head_repository: {full_name: 'fork/r'}}), greenRun(6, {event: 'schedule'})];
  const moved = await base('schedule', {}, {greenRuns: async () => runs});
  assert.equal(moved.full, true, 'the current run, pushes and forks are passed over');
  assert.match(moved.reason, /changed since .*runs\/6$/);
  const same = await base('schedule', {}, {greenRuns: async () => [greenRun(5, {event: 'schedule', head_sha: H})]});
  assert.deepEqual([same.full, same.base], [false, H]);
  assert.equal((await base('schedule', {}, {forceFull: true})).full, true);
  // A schedule that calls this workflow is judged by the caller's runs.
  const called = await decideBase({eventName: 'schedule', payload: {}, env, head: {sha: H, parents: [B]}, fullLabel: '',
    greenRuns: async () => [], scheduledRuns: async () => [greenRun(5, {event: 'schedule', head_sha: H})]});
  assert.deepEqual([called.full, called.base], [false, H]);
});

test('jobs run when their paths change or their Go packages are affected', () => {
  const config = parseConfig(JSON.stringify({
    docs: ['docs/**'], lint: {go: ['./...']}, image: {paths: ['Dockerfile'], go: ['./cmd/app']}, conformance: {go: ['./conformance/...']},
  }), '.github/workflows/**');
  const go = dirs => ({full: false, reason: 'x', dirs});
  const pick = (files, goResult) => selectJobs(config, {full: false, files, go: goResult}).jobs;
  assert.deepEqual(pick(['docs/a.md'], go([])), ['docs']);
  assert.deepEqual(pick(['internal/x.go'], go(['./internal'])), ['lint']);
  assert.deepEqual(pick(['internal/x.go'], go(['./internal', './cmd/app'])), ['lint', 'image']);
  assert.deepEqual(pick(['Dockerfile'], go([])), ['image']);
  assert.deepEqual(pick(['conformance/a.go'], go(['./conformance/suite'])), ['lint', 'conformance']);
  assert.deepEqual(pick(['go.mod'], {full: true, reason: 'manifest', dirs: []}), ['lint', 'image', 'conformance']);
  assert.deepEqual(pick([], go([])), []);
  const shared = selectJobs(config, {full: false, files: ['.github/workflows/ci.yml'], go: go([])});
  assert.deepEqual([shared.jobs, shared.shared], [['docs', 'lint', 'image', 'conformance'], '.github/workflows/ci.yml']);
  assert.deepEqual(shared.wide, shared.jobs);
  const full = selectJobs(config, {full: true, files: [], go: null});
  assert.deepEqual([full.jobs, full.wide], [['docs', 'lint', 'image', 'conformance'], ['docs', 'lint', 'image', 'conformance']]);
  // A job's own paths are its configuration: they widen it to every package.
  const own = selectJobs(config, {full: false, files: ['Dockerfile', 'internal/x.go'], go: go(['./internal'])});
  assert.deepEqual([own.jobs, own.wide], [['lint', 'image'], ['image']]);
});

// The packaged action over a real repository, with a stub GitHub API serving
// the run history, as a child process so the stub keeps serving.
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const {execFile, execFileSync} = require('node:child_process');
function git(cwd, ...args) {
  // A throwaway fixture repository: no signing, a fixed identity.
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args], {cwd, encoding: 'utf8'}).trim();
}
function readCommandFile(file) {
  const values = {};
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i]);
    if (!match) continue;
    const body = [];
    while (lines[++i] !== match[2]) body.push(lines[i]);
    values[match[1]] = body.join('\n');
  }
  return values;
}
function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), content);
  }
}
// origin holds main (base, then a second commit) and a feature branch; the
// checkout is a depth-1 clone of the pull request's merge, as actions/checkout
// leaves it, so the action must fetch the base itself.
function repository(t, files = {'README.md': 'base\n', 'docs/guide.md': 'guide\n', 'Dockerfile': 'FROM scratch\n'},
  change = {'docs/guide.md': 'changed\n'}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-scope-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  write(origin, {...files, '.github/workflows/ci.yml': 'on: push\njobs:\n  docs:\n  image:\n  test:\n'});
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'base');
  const base = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feature');
  write(origin, change);
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'change');
  const head = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  git(origin, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  const merge = git(origin, 'rev-parse', 'HEAD');
  const workspace = path.join(root, 'workspace');
  git(root, 'clone', '-q', '--depth=1', 'file://' + origin, workspace);
  return {root, workspace, base, head, merge};
}
async function runScope(t, repo, {event, payload, inputs = {}, routes = {}}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    requests.push({path: url.pathname, query: Object.fromEntries(url.searchParams)});
    const body = routes[url.pathname];
    response.statusCode = body ? 200 : 500;
    response.end(body ? JSON.stringify(body) : '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const eventPath = path.join(repo.root, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const outputFile = path.join(repo.root, 'output-' + requests.length + '-' + Date.now());
  const childEnv = {PATH: process.env.PATH, HOME: process.env.HOME, GOFLAGS: '', GOPROXY: 'off', GOTOOLCHAIN: 'local',
    GOCACHE: process.env.GOCACHE || path.join(repo.root, 'gocache'), GOPATH: process.env.GOPATH || path.join(repo.root, 'gopath'), GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port,
    GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/heads/main', GITHUB_RUN_ID: '9',
    GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_REF: 'refs/heads/main', GITHUB_WORKSPACE: repo.workspace,
    GITHUB_OUTPUT: outputFile, RUNNER_TEMP: repo.root,
    INPUT_JOBS: JSON.stringify({docs: ['docs/**'], image: ['Dockerfile']}), INPUT_SHARED: '.github/**', INPUT_FULL: 'false',
    'INPUT_FULL-LABEL': 'full-ci', INPUT_LOOKBACK: '20', 'INPUT_GO-DIRECTORY': '.', INPUT_TOKEN: 'tok', ...inputs};
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, '../scope/index.cjs')],
    {cwd: repo.workspace, env: childEnv, encoding: 'utf8'},
    (error, out, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(out))));
  return {stdout, requests, outputs: readCommandFile(outputFile)};
}

test('packaged action scopes a pull request merge, fetching its base', async t => {
  const repo = repository(t);
  const {outputs, requests} = await runScope(t, repo, {event: 'pull_request',
    payload: {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}}});
  assert.deepEqual(requests, [], 'a pull request reads no run history');
  assert.equal(outputs.full, 'false');
  assert.equal(outputs.base, repo.base);
  assert.deepEqual(JSON.parse(outputs.jobs), ['docs']);
  assert.equal(fs.readFileSync(outputs.files, 'utf8'), 'docs/guide.md\n');
  assert.equal(outputs['go-packages'], '{}');
});

test('packaged action scopes a push against the last green run', async t => {
  const repo = repository(t);
  const {outputs, requests} = await runScope(t, repo, {event: 'push', payload: {},
    routes: {'/repos/o/r/actions/workflows/ci.yml/runs': {workflow_runs: [
      {id: 8, conclusion: 'success', head_branch: 'main', event: 'push', head_sha: repo.base,
        head_repository: {full_name: 'o/r'}, html_url: 'https://github.com/o/r/actions/runs/8'}]}}});
  assert.deepEqual(requests[0].query, {branch: 'main', status: 'success', exclude_pull_requests: 'true', per_page: '20'});
  assert.equal(outputs.base, repo.base);
  assert.deepEqual(JSON.parse(outputs.jobs), ['docs']);
});

test('packaged action runs everything when it cannot decide', async t => {
  const repo = repository(t);
  const unavailable = await runScope(t, repo, {event: 'push', payload: {}});
  assert.equal(unavailable.outputs.full, 'true');
  assert.deepEqual(JSON.parse(unavailable.outputs.jobs), ['docs', 'image']);
  assert.match(unavailable.stdout, /::warning::run history unavailable/);
  const missing = await runScope(t, repo, {event: 'push', payload: {},
    routes: {'/repos/o/r/actions/workflows/ci.yml/runs': {workflow_runs: [
      {id: 8, conclusion: 'success', head_branch: 'main', event: 'push', head_sha: 'e'.repeat(40),
        head_repository: {full_name: 'o/r'}, html_url: 'u'}]}}});
  assert.equal(missing.outputs.full, 'true', 'a base that cannot be fetched');
  assert.match(missing.outputs.reason, /diff against e+ is unavailable/);
  const scheduled = await runScope(t, repo, {event: 'schedule', payload: {},
    routes: {'/repos/o/r/actions/workflows/ci.yml/runs': {workflow_runs: []}}});
  assert.equal(scheduled.outputs.full, 'true');
  assert.equal(scheduled.outputs.files, '');
  const unchanged = await runScope(t, repo, {event: 'schedule', payload: {},
    routes: {'/repos/o/r/actions/workflows/ci.yml/runs': {workflow_runs: [
      {id: 8, conclusion: 'success', head_branch: 'main', event: 'schedule', head_sha: repo.merge,
        head_repository: {full_name: 'o/r'}, html_url: 'https://github.com/o/r/actions/runs/8'}]}}});
  assert.deepEqual([unchanged.outputs.full, unchanged.outputs.jobs], ['false', '[]']);
  assert.match(unchanged.outputs.reason, /last green scheduled run already checked/);
});

test('packaged action narrows Go jobs to the affected packages', async t => {
  let go = true;
  try { execFileSync('go', ['version'], {stdio: 'ignore'}); } catch { go = false; }
  if (!go && !process.env.GITHUB_ACTIONS) return t.skip('go is not on PATH');
  const repo = repository(t, {
    'go.mod': 'module example.com/m\n\ngo 1.22\n',
    'a/a.go': 'package a\n',
    'b/b.go': 'package b\n\nimport _ "example.com/m/a"\n',
    'cmd/app/main.go': 'package main\n\nfunc main() {}\n',
    'docs/guide.md': 'guide\n',
  }, {'a/a.go': 'package a\n\nconst X = 1\n', 'docs/guide.md': 'changed\n'});
  const jobs = {test: {go: ['./...']}, image: {paths: ['Dockerfile'], go: ['./cmd/app']}, docs: ['docs/**']};
  const {outputs} = await runScope(t, repo, {event: 'pull_request',
    payload: {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}},
    inputs: {INPUT_JOBS: JSON.stringify(jobs), 'INPUT_GO-IGNORE': 'docs/**\n'}});
  assert.deepEqual(JSON.parse(outputs.jobs), ['test', 'docs']);
  assert.deepEqual(JSON.parse(outputs['wide-jobs']), ['docs']);
  assert.deepEqual(JSON.parse(outputs['go-packages']), {'.': ['./a', './b']});
  assert.equal(outputs['go-args'], 'example.com/m/a example.com/m/b');
  const unignored = await runScope(t, repo, {event: 'pull_request',
    payload: {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}},
    inputs: {INPUT_JOBS: JSON.stringify(jobs)}});
  assert.deepEqual(JSON.parse(unignored.outputs.jobs), ['test', 'image', 'docs'], 'an unowned file affects every package');
  assert.deepEqual(JSON.parse(unignored.outputs['go-packages']), {'.': ['./...']});
  assert.equal(unignored.outputs['go-args'], 'example.com/m/...');
  assert.match(unignored.outputs['go-reason'], /no package owns docs\/guide\.md/);
});

test('packaged action refuses a job the workflow does not define', async t => {
  const repo = repository(t);
  await assert.rejects(runScope(t, repo, {event: 'pull_request',
    payload: {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}},
    inputs: {INPUT_JOBS: JSON.stringify({docs: ['docs/**'], lnit: ['**']})}}), /ci\.yml does not define: lnit/);
});

test('packaged action loads each go-builds configuration', async t => {
  let go = true;
  try { execFileSync('go', ['version'], {stdio: 'ignore'}); } catch { go = false; }
  if (!go && !process.env.GITHUB_ACTIONS) return t.skip('go is not on PATH');
  if (process.platform === 'win32') return t.skip('the host is the Windows configuration');
  const repo = repository(t, {'go.mod': 'module example.com/m\n\ngo 1.22\n', 'a/a.go': 'package a\n', 'w/w_windows.go': 'package w\n'},
    {'w/w_windows.go': 'package w\n\nconst X = 1\n'});
  const pull = {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}};
  const jobs = JSON.stringify({test: {go: ['./...']}});
  const host = await runScope(t, repo, {event: 'pull_request', payload: pull, inputs: {INPUT_JOBS: jobs}});
  assert.match(host.outputs['go-reason'], /no package owns w\/w_windows\.go/);
  const both = await runScope(t, repo, {event: 'pull_request', payload: pull,
    inputs: {INPUT_JOBS: jobs, 'INPUT_GO-BUILDS': '\nGOOS=windows GOARCH=amd64\n'}});
  assert.deepEqual(JSON.parse(both.outputs['go-packages']), {'.': ['./w']});
  assert.match(both.stdout, /Go package graph: GOOS=windows GOARCH=amd64/);
});

test('packaged action reads job IDs from jobs-workflow, history from workflow', async t => {
  const repo = repository(t, {'README.md': 'base\n', 'docs/guide.md': 'guide\n',
    '.github/workflows/_validation.yml': 'on: workflow_call\njobs:\n  lint:\n  test:\n'}, {'docs/guide.md': 'changed\n'});
  const pull = {pull_request: {head: {sha: repo.head}, base: {sha: repo.base}, labels: []}};
  const jobs = JSON.stringify({lint: ['docs/**'], test: ['src/**']});
  // The caller (the running workflow, ci.yml here) does not define lint.
  await assert.rejects(runScope(t, repo, {event: 'pull_request', payload: pull, inputs: {INPUT_JOBS: jobs}}),
    /ci\.yml does not define: lint\n/);
  const {outputs} = await runScope(t, repo, {event: 'pull_request', payload: pull,
    inputs: {INPUT_JOBS: jobs, 'INPUT_JOBS-WORKFLOW': '_validation.yml'}});
  assert.deepEqual(JSON.parse(outputs.jobs), ['lint']);
  // A push still reads the caller's green runs.
  const push = await runScope(t, repo, {event: 'push', payload: {},
    inputs: {INPUT_JOBS: jobs, 'INPUT_JOBS-WORKFLOW': '_validation.yml'},
    routes: {'/repos/o/r/actions/workflows/ci.yml/runs': {workflow_runs: [
      {id: 8, conclusion: 'success', head_branch: 'main', event: 'push', head_sha: repo.base,
        head_repository: {full_name: 'o/r'}, html_url: 'https://github.com/o/r/actions/runs/8'}]}}});
  assert.equal(push.outputs.base, repo.base);
  await assert.rejects(runScope(t, repo, {event: 'pull_request', payload: pull,
    inputs: {INPUT_JOBS: jobs, 'INPUT_JOBS-WORKFLOW': '../x.yml'}}), /jobs-workflow must be a file name/);
});
