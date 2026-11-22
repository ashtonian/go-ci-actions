'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {LIST_FIELDS, affectedPackages, byModule, parseStream, rootDirs} = require('../lib/goaffected.cjs');

test('go list output parses object by object', () => {
  const text = '{\n\t"ImportPath": "a",\n\t"Module": {\n\t\t"Path": "a"\n\t}\n}\n{\n\t"ImportPath": "b"\n}\n';
  assert.deepEqual(parseStream(text).map(entry => entry.ImportPath), ['a', 'b']);
  assert.deepEqual(parseStream(''), []);
  assert.throws(() => parseStream('{\n\t"ImportPath": "a"\n'), /unterminated/);
});

// A workspace of three modules: app imports lib/sub (and lib only from an
// external test), tool is independent, and lib/tagged builds only under the
// "integration" tag.
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
function list(root, tags = '') {
  const env = {...process.env, GOFLAGS: '', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: path.join(root, 'go.work')};
  const go = args => parseStream(execFileSync('go', args, {cwd: root, env, encoding: 'utf8'}));
  const modules = go(['list', '-m', '-json']);
  const entries = go(['list', '-e', '-test', '-json=' + LIST_FIELDS, ...(tags ? ['-tags', tags] : []),
    ...modules.map(module => module.Path + '/...')]);
  return {modules, entries};
}
function affected(root, files, {tags = '', exists = fs.existsSync} = {}) {
  const {modules, entries} = list(root, tags);
  const result = affectedPackages({root, modules, entries, changed: files.map(file => path.join(root, file)), exists});
  return {result, modules: byModule(root, modules, result), dirs: result.full ? [] : rootDirs(root, result)};
}

// Without Go the package graph cannot be built; CI always has it.
const needsGo = goAvailable() || process.env.GITHUB_ACTIONS ? {} : {skip: 'go is not on PATH'};

test('a changed package affects itself and its reverse dependencies across modules', needsGo, t => {
  const root = workspace(t);
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).modules, {app: ['.'], lib: ['./sub']});
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
  }
  const removed = affected(root, ['lib/gone/gone.go'], {exists: () => false}).result;
  assert.match(removed.reason, /Go file outside every remaining package was removed: lib\/gone\/gone\.go/);
});

test('a package that does not load is always affected', needsGo, t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'tool/tool.go'), 'package tool\n\nimport _ "example.com/missing"\n');
  assert.deepEqual(affected(root, ['lib/sub/sub.go']).modules, {app: ['.'], lib: ['./sub'], tool: ['.']});
});
