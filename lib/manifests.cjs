'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const MANIFESTS = ['go.mod', 'go.sum', 'go.work', 'go.work.sum'];
// A workspace path or glob as a workspace-relative POSIX pattern. Patterns
// that leave the workspace are refused rather than silently ignored.
function relativePattern(workspace, name, value) {
  const relative = path.relative(workspace, path.resolve(workspace, value)).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(name + ' must stay inside the workspace: ' + value);
  }
  return relative || '.';
}
// Explicit patterns are relative to the workspace, one per line, with `!`
// excluding matches. Without any, the manifests under the directory holding
// go-version-file: the module or workspace this job builds, not sibling
// checkouts elsewhere in the workspace.
function manifestPatterns(workspace, patterns, versionFile) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('GITHUB_WORKSPACE must be an absolute path');
  const include = [], exclude = ['**/node_modules'];
  for (const raw of patterns.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) exclude.push(relativePattern(workspace, 'cache-dependency-path', line.slice(1).trim()));
    else include.push(relativePattern(workspace, 'cache-dependency-path', line));
  }
  if (!include.length) {
    const dir = path.posix.dirname(relativePattern(workspace, 'go-version-file', versionFile || 'go.mod'));
    for (const name of MANIFESTS) include.push(path.posix.join(dir, '**', name));
  }
  return {workspace, include, exclude};
}
// hashFiles' digest, a SHA-256 over each matched file's SHA-256, in sorted
// path order so the key does not depend on directory listing order. Empty
// when nothing matches.
function dependencyHash({workspace, include, exclude}) {
  const files = [...new Set(fs.globSync(include, {cwd: workspace, exclude}))]
    .filter(file => fs.statSync(path.join(workspace, file)).isFile())
    .sort();
  if (!files.length) return {hash: '', files: 0};
  const result = crypto.createHash('sha256');
  for (const file of files) {
    result.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, file))).digest());
  }
  return {hash: result.digest('hex'), files: files.length};
}
module.exports = {dependencyHash, manifestPatterns};
