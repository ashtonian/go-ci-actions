'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

for (const [mode, backend] of [['read-write', 'github'], ['read-only', 'github'], ['read-write', 'remote']]) {
  test('packaged post hook honors ' + mode + ' with the ' + backend + ' build cache', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ci-post-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const build = path.join(root, 'build'), modules = path.join(root, 'modules');
    fs.mkdirSync(build); fs.mkdirSync(modules);
    const stale = path.join(build, 'stale');
    fs.writeFileSync(stale, 'old');
    const old = new Date(Date.now() - 4 * 3600000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(build, 'current'), 'new');
    fs.writeFileSync(path.join(modules, 'source'), 'module source');
    const state = {build, modules, 'start-ms': String(Date.now()), 'max-staleness-hours': '2',
      'cache-mode': mode, backend, 'matched-key': 'go-v1-existing'};
    const summary = path.join(root, 'summary');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../_lifecycle/post.cjs')], {
      env: {...process.env, STATE_cache: JSON.stringify(state), GITHUB_STEP_SUMMARY: summary}, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(stale), mode === 'read-only' || backend === 'remote');
    assert.equal(fs.readFileSync(path.join(modules, 'source'), 'utf8'), 'module source');
    assert.match(result.stdout, /Go cache metrics:/);
    assert.match(fs.readFileSync(summary, 'utf8'), new RegExp('\\| ' + backend + ' \\|'));
  });
}
