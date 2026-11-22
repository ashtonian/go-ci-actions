'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {LIST_FIELDS, affectedPackages, byModule, importArgs, parseStream, rootDirs} = require('../lib/goaffected.cjs');

test('go list output parses object by object', () => {
  const text = '{\n\t"ImportPath": "a",\n\t"Module": {\n\t\t"Path": "a"\n\t}\n}\n{\n\t"ImportPath": "b"\n}\n';
  assert.deepEqual(parseStream(text).map(entry => entry.ImportPath), ['a', 'b']);
  assert.deepEqual(parseStream(''), []);
  assert.throws(() => parseStream('{\n\t"ImportPath": "a"\n'), /unterminated/);
});

// A workspace of three modules: app imports lib/sub (and lib only from an
// external test, and lib/winonly only on Windows), tool is independent,
// lib/tagged builds only under the "integration" tag, lib/notint only
// without it, and lib/winonly only for Windows.
const FILES = {
  'go.work': 'go 1.22\n\nuse (\n\t./lib\n\t./app\n\t./tool\n)\n',
  'lib/go.mod': 'module example.com/lib\n\ngo 1.22\n',
  'lib/lib.go': 'package lib\n',
  'lib/sub/sub.go': 'package sub\n',
  'lib/sub/testdata/case/input.txt': 'case\n',
  'lib/assets/embed.go': 'package assets\n\nimport _ "embed"\n\n//go:embed static/page.html\nvar Page string\n',
  'lib/assets/static/page.html': '<p>page</p>\n',
  'lib/tagged/tagged.go': '//go:build integration\n\npackage tagged\n\nimport _ "example.com/lib/sub"\n',
  'lib/README.md': 'lib\n',
  'app/go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire example.com/lib v0.0.0\n',
  'app/main.go': 'package main\n\nimport _ "example.com/lib/sub"\n\nfunc main() {}\n',
  'app/main_test.go': 'package main_test\n\nimport (\n\t"testing"\n\n\t_ "example.com/lib"\n)\n\nfunc TestMain(t *testing.T) {}\n',
  'lib/winonly/winonly_windows.go': 'package winonly\n',
  'lib/notint/notint.go': '//go:build !integration\n\npackage notint\n',
  'app/main_windows.go': 'package main\n\nimport _ "example.com/lib/winonly"\n',
  'tool/go.mod': 'module example.com/tool\n\ngo 1.22\n',
  'tool/tool.go': 'package tool\n',
};
function goAvailable() {
  try { execFileSync('go', ['version'], {stdio: 'ignore'}); return true; } catch { return false; }
}
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-affected-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
// The unioned graphs of each build configuration, as the scope action loads them.
function list(root, builds) {
  const base = {...process.env, GOFLAGS: '', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: path.join(root, 'go.work')};
  const go = (args, env = {}) => parseStream(execFileSync('go', args, {cwd: root, env: {...base, ...env}, encoding: 'utf8'}));
  const modules = go(['list', '-m', '-json']);
  const entries = builds.flatMap(build => go(['list', '-e', '-test', '-json=' + LIST_FIELDS,
    ...(build.tags ? ['-tags', build.tags] : []), ...modules.map(module => module.Path + '/...')], build.env));
  return {modules, entries};
}
function affected(root, files, {tags = '', builds = [{tags}], exists = fs.existsSync, owners} = {}) {
  const {modules, entries} = list(root, builds);
  const result = affectedPackages({root, modules, entries, changed: files.map(file => path.join(root, file)), exists, owners});
  return {result, modules: byModule(root, modules, result), dirs: result.full ? [] : rootDirs(root, result),
    args: importArgs(modules, result)};
}

// Without Go the package graph cannot be built; CI always has it.
const needsGo = goAvailable() || process.env.GITHUB_ACTIONS ? {} : {skip: 'go is not on PATH'};

test('a changed package affects itself and its reverse dependencies across modules', needsGo, t => {
  const root = workspace(t);
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).modules, {app: ['.'], lib: ['./sub']});
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).args, ['example.com/app', 'example.com/lib/sub']);
  assert.deepEqual(affected(root, ['lib/lib.go']).modules, {app: ['.'], lib: ['.']}, 'an external test import counts');
  assert.deepEqual(affected(root, ['tool/tool.go']).modules, {tool: ['.']});
  assert.deepEqual(affected(root, ['app/main_test.go']).dirs, ['./app']);
  assert.deepEqual(affected(root, []).modules, {});
});

test('testdata and embedded files belong to their package', needsGo, t => {
  const root = workspace(t);
  assert.deepEqual(affected(root, ['lib/sub/testdata/case/input.txt']).modules, {app: ['.'], lib: ['./sub']});
  assert.deepEqual(affected(root, ['lib/assets/static/page.html']).modules, {lib: ['./assets']});
  // Its tests can read any file beside them.
  assert.deepEqual(affected(root, ['lib/README.md']).modules, {app: ['.'], lib: ['.']});
});

test('build tags bring tagged packages and their imports into the graph', needsGo, t => {
  const root = workspace(t);
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).modules.lib, ['./sub'], 'excluded by its tag, not broken');
  assert.deepEqual(affected(root, ['lib/sub/sub.go'], {tags: 'integration'}).modules.lib, ['./sub', './tagged']);
});

test('anything the package graph cannot account for affects every package', needsGo, t => {
  const root = workspace(t);
  const cases = {
    'go.work': /workspace manifest go\.work/,
    'go.work.sum': /workspace manifest go\.work\.sum/,
    'lib/go.mod': /module manifest lib\/go\.mod/,
    'app/go.sum': /module manifest app\/go\.sum/,
    'docs/guide.md': /no package owns docs\/guide\.md/,
    'scripts/ci.sh': /no package owns scripts\/ci\.sh/,
  };
  for (const [file, reason] of Object.entries(cases)) {
    const {result, modules} = affected(root, [file]);
    assert.equal(result.full, true, file);
    assert.match(result.reason, reason);
    assert.deepEqual(modules, {app: ['./...'], lib: ['./...'], tool: ['./...']});
    assert.deepEqual(affected(root, [file]).args.sort(), ['example.com/app/...', 'example.com/lib/...', 'example.com/tool/...']);
  }
  const removed = affected(root, ['lib/gone/gone.go'], {exists: () => false}).result;
  assert.match(removed.reason, /Go file outside every remaining package was removed: lib\/gone\/gone\.go/);
});

test('a package that does not load is always affected', needsGo, t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'tool/tool.go'), 'package tool\n\nimport _ "example.com/missing"\n');
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).modules, {app: ['.'], lib: ['./sub'], tool: ['.']});
});

test('declared owners make a file outside every package affect the packages that read it', needsGo, t => {
  const root = workspace(t);
  const owners = file => (file === path.join(root, 'docs/guide.md') ? [path.join(root, 'tool')] :
    file === path.join(root, 'lib/README.md') ? [path.join(root, 'app')] : []);
  assert.deepEqual(affected(root, ['docs/guide.md'], {owners}).modules, {tool: ['.']});
  assert.deepEqual(affected(root, ['lib/README.md'], {owners}).modules, {app: ['.'], lib: ['.']}, 'in addition to its own package');
  assert.throws(() => affected(root, ['docs/guide.md'], {owners: () => [path.join(root, 'nowhere')]}), /go-owners names nowhere/);
});

test('the import-path arguments run as one go test across the workspace', needsGo, t => {
  const root = workspace(t);
  const {args} = affected(root, ['lib/sub/sub.go']);
  const env = {...process.env, GOFLAGS: '', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: path.join(root, 'go.work')};
  const out = execFileSync('go', ['test', ...args], {cwd: root, env, encoding: 'utf8'});
  assert.match(out, /example\.com\/app/);
  assert.match(out, /example\.com\/lib\/sub/);
  // Package list mode: an unchanged rerun replays from the test cache.
  assert.match(execFileSync('go', ['test', ...args], {cwd: root, env, encoding: 'utf8'}), /ok\s+example\.com\/app\s+\(cached\)/);
});

test('the graphs of several build configurations are unioned', needsGo, t => {
  const root = workspace(t);
  const host = {tags: ''}, windows = {env: {GOOS: 'windows', GOARCH: 'amd64'}, tags: ''};
  if (process.platform === 'win32') return t.skip('the host is the Windows configuration');
  assert.match(affected(root, ['lib/winonly/winonly_windows.go']).result.reason, /no package owns lib\/winonly/,
    'the host graph alone does not hold the Windows package');
  assert.deepEqual(affected(root, ['lib/winonly/winonly_windows.go'], {builds: [host, windows]}).modules,
    {app: ['.'], lib: ['./winonly']});
  assert.deepEqual(affected(root, ['lib/sub/sub.go'], {builds: [host, windows, {tags: 'integration'}]}).modules,
    {app: ['.'], lib: ['./sub', './tagged']}, 'each configuration adds what it builds');
  // A tag set is not covered by its superset when a constraint negates a tag.
  assert.equal(affected(root, ['lib/notint/notint.go'], {builds: [{tags: 'integration'}]}).result.full, true);
  assert.deepEqual(affected(root, ['lib/notint/notint.go'], {builds: [{tags: ''}, {tags: 'integration'}]}).modules,
    {lib: ['./notint']});
});
