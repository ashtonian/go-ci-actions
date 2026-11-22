'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {alreadyPassed, lookback, matches, workflowFile} = require('../lib/history.cjs');

const SHA = 'a'.repeat(40);
const run = (id, sha = SHA) => ({id, head_sha: sha, html_url: 'https://github.com/o/r/actions/runs/' + id});
const job = (name, conclusion) => ({name, conclusion});
// Earlier runs newest first, with the jobs each one ran.
async function decide(history, names = ['conformance']) {
  const jobs = new Map(history.map(([r, list]) => [r.id, list]));
  const asked = [];
  const result = await alreadyPassed({runs: history.map(([r]) => r), sha: SHA, names,
    jobsOf: async r => { asked.push(r.id); return jobs.get(r.id); }});
  return {...result, asked};
}

test('the newest run on this commit that ran the jobs decides', async () => {
  const passed = await decide([
    [run(3), [job('models', 'success'), job('conformance (emqx)', 'skipped')]],
    [run(2), [job('conformance (emqx)', 'success'), job('conformance (hivemq)', 'success')]],
    [run(1), [job('conformance (emqx)', 'failure')]],
  ]);
  assert.equal(passed.passed, true);
  assert.match(passed.reason, /runs\/2$/);
  assert.deepEqual(passed.asked, [3, 2], 'older runs are not consulted');
  const failed = await decide([[run(2), [job('conformance (emqx)', 'success'), job('conformance (hivemq)', 'failure')]]]);
  assert.equal(failed.passed, false);
  const cancelled = await decide([[run(2), [job('conformance (emqx)', 'cancelled')]]]);
  assert.equal(cancelled.passed, false);
});

test('a run on another commit ends the search', async () => {
  const result = await decide([
    [run(3), [job('conformance (emqx)', 'skipped')]],
    [run(2, 'b'.repeat(40)), [job('conformance (emqx)', 'success')]],
    [run(1), [job('conformance (emqx)', 'success')]],
  ]);
  assert.equal(result.passed, false);
  assert.match(result.reason, /commit changed since .*runs\/2$/);
  assert.deepEqual(result.asked, [3]);
});

test('without a run that ran the jobs on this commit, they run', async () => {
  assert.equal((await decide([])).passed, false);
  assert.equal((await decide([[run(2), [job('models', 'success'), job('conformance (emqx)', 'skipped')]]])).passed, false);
  assert.equal((await decide([[run(2), [job('conformancex', 'success')]]])).passed, false, 'a different job name');
});

test('names cover their matrix variants only', () => {
  assert.ok(matches(job('conformance', 'success'), ['conformance']));
  assert.ok(matches(job('conformance (emqx-ws)', 'success'), ['conformance']));
  assert.ok(!matches(job('conformance-extra', 'success'), ['conformance']));
  assert.ok(matches(job('stress', 'success'), ['fuzz', 'stress']));
  assert.ok(matches(job('ci / test (ubuntu-latest)', 'success'), ['ci']), 'a reusable-workflow call covers its jobs');
  assert.ok(matches(job('ci / test (ubuntu-latest)', 'success'), ['ci / test']));
  assert.ok(!matches(job('cio / test', 'success'), ['ci']));
});

test('the workflow file and lookback are validated', () => {
  assert.equal(workflowFile({GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/nightly.yml@refs/heads/main'}),
    'nightly.yml');
  for (const ref of ['', 'x/y/.github/workflows/nightly.yml@refs/heads/main', 'o/r/nightly.yml@refs/heads/main']) {
    assert.throws(() => workflowFile({GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW_REF: ref}), /GITHUB_WORKFLOW_REF/, ref);
  }
  assert.equal(lookback('10'), 10);
  for (const raw of ['0', '51', '-1', '1.5', 'x', '']) assert.throws(() => lookback(raw), /lookback/, raw);
});

// The packaged action against a stub GitHub API, as a child process so the
// stub keeps serving.
async function runAction(t, routes) {
  const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
  const {execFile} = require('node:child_process');
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    requests.push({path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.authorization});
    const body = routes[url.pathname];
    response.statusCode = body ? 200 : 500;
    response.end(body ? JSON.stringify(body) : '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-history-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const env = {PATH: process.env.PATH, GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port,
    GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/nightly.yml@refs/heads/master',
    GITHUB_SHA: SHA, GITHUB_RUN_ID: '9', GITHUB_OUTPUT: path.join(root, 'output'),
    INPUT_JOBS: 'conformance\n', INPUT_EVENT: 'schedule', INPUT_BRANCH: 'master', INPUT_LOOKBACK: '10', INPUT_TOKEN: 'tok'};
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, '../already-passed/index.cjs')], {env, encoding: 'utf8'},
    (error, out, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(out))));
  const output = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  return {stdout, requests, passed: /passed<<[^\n]+\n(true|false)\n/.exec(output)[1]};
}

test('packaged action reads the workflow history and skips the running run', async t => {
  const result = await runAction(t, {
    '/repos/o/r/actions/workflows/nightly.yml/runs': {workflow_runs: [run(9), run(2)]},
    '/repos/o/r/actions/runs/2/jobs': {jobs: [job('conformance (emqx)', 'success')]},
  });
  assert.equal(result.passed, 'true');
  assert.deepEqual(result.requests[0].query, {event: 'schedule', branch: 'master', status: 'completed', per_page: '10'});
  assert.equal(result.requests[0].auth, 'Bearer tok');
  assert.deepEqual(result.requests.map(r => r.path), ['/repos/o/r/actions/workflows/nightly.yml/runs', '/repos/o/r/actions/runs/2/jobs']);
});

test('packaged action runs the jobs when the history is unavailable', async t => {
  const result = await runAction(t, {});
  assert.equal(result.passed, 'false');
  assert.match(result.stdout, /::notice::history unavailable \(GET actions\/workflows\/nightly\.yml\/runs: HTTP 500\); the jobs run/);
});
