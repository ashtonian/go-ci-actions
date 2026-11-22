'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {dependencyHash, manifestPatterns} = require('../lib/manifests.cjs');

// A workspace holding a module, a nested module, a sibling checkout and
// directories that never hold the module's manifests.
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-manifests-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const files = {
    'app/go.mod': 'module app\n', 'app/go.sum': 'app sums\n', 'app/tools/go.mod': 'module tools\n',
    'app/go.work': 'use .\n', 'app/node_modules/pkg/go.mod': 'module vendored\n',
    'app/.cache/mod/go.mod': 'module cached\n', 'sibling/go.mod': 'module sibling\n', 'sibling/go.sum': 'sibling sums\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
// The expected digest, computed independently of the glob: SHA-256 over each
// listed file's SHA-256, in the given (sorted) order.
function digest(root, files) {
  const result = crypto.createHash('sha256');
  for (const file of files) result.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest());
  return result.digest('hex');
}
const hash = (root, patterns, versionFile) => dependencyHash(manifestPatterns(root, patterns, versionFile));

test('without patterns only the manifests under the go-version-file directory are hashed', t => {
  const root = workspace(t);
  const want = ['app/go.mod', 'app/go.sum', 'app/go.work', 'app/tools/go.mod'];
  assert.deepEqual(hash(root, '', 'app/go.mod'), {hash: digest(root, want), files: 4});
  assert.deepEqual(hash(root, '', path.join(root, 'app/go.work')), {hash: digest(root, want), files: 4},
    'an absolute go-version-file inside the workspace names the same directory');
  const before = hash(root, '', 'app/go.mod').hash;
  fs.writeFileSync(path.join(root, 'sibling/go.sum'), 'changed\n');
  fs.writeFileSync(path.join(root, 'app/node_modules/pkg/go.mod'), 'changed\n');
  fs.writeFileSync(path.join(root, 'app/.cache/mod/go.mod'), 'changed\n');
  assert.equal(hash(root, '', 'app/go.mod').hash, before, 'siblings, node_modules and dot-directories are not hashed');
  fs.writeFileSync(path.join(root, 'app/tools/go.mod'), 'module tools\n\ngo 1.27\n');
  assert.notEqual(hash(root, '', 'app/go.mod').hash, before, 'a nested module manifest is hashed');
});

test('the default go-version-file hashes the manifests of the whole workspace', t => {
  const root = workspace(t);
  const want = ['app/go.mod', 'app/go.sum', 'app/go.work', 'app/tools/go.mod', 'sibling/go.mod', 'sibling/go.sum'];
  assert.deepEqual(hash(root, '', ''), {hash: digest(root, want), files: 6});
  assert.deepEqual(hash(root, '', 'go.mod'), {hash: digest(root, want), files: 6});
});

test('explicit patterns are relative to the workspace and support exclusions and comments', t => {
  const root = workspace(t);
  assert.deepEqual(hash(root, 'sibling/go.sum', 'app/go.mod'), {hash: digest(root, ['sibling/go.sum']), files: 1});
  assert.deepEqual(hash(root, '# module sums\n**/go.sum\n!sibling/**\n', 'app/go.mod'),
    {hash: digest(root, ['app/go.sum']), files: 1});
  assert.deepEqual(hash(root, 'app/go.sum\napp/*.sum', ''), {hash: digest(root, ['app/go.sum']), files: 1},
    'a file two patterns match is hashed once');
  fs.mkdirSync(path.join(root, 'empty/go.sum'), {recursive: true});
  assert.deepEqual(hash(root, 'empty/go.sum\nmissing/go.sum', ''), {hash: '', files: 0},
    'directories and unmatched patterns hash to nothing');
});

test('patterns and the version file must stay inside the workspace', t => {
  const root = workspace(t);
  for (const patterns of ['../go.sum', '!../x', path.dirname(root) + '/go.sum', 'app/../../go.sum']) {
    assert.throws(() => manifestPatterns(root, patterns, ''), /cache-dependency-path must stay inside the workspace/, patterns);
  }
  assert.throws(() => manifestPatterns(root, '', '../go.mod'), /go-version-file must stay inside the workspace/);
  assert.throws(() => manifestPatterns('', '', 'go.mod'), /GITHUB_WORKSPACE/);
  assert.throws(() => manifestPatterns('relative', '', 'go.mod'), /GITHUB_WORKSPACE/);
});
