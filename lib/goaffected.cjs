'use strict';
const path = require('node:path');
const LIST_FIELDS = 'ImportPath,Name,Dir,ForTest,Module,Deps,EmbedFiles,TestEmbedFiles,XTestEmbedFiles,Error,DepsErrors';
const WORKSPACE_MANIFESTS = new Set(['go.work', 'go.work.sum']);
const MODULE_MANIFESTS = new Set(['go.mod', 'go.sum']);

// go list -json prints objects back to back, each closing with a "}" in the
// first column; nested values are indented.
function parseStream(text) {
  const values = [];
  const end = /^}$/gm;
  let start = 0, match;
  while ((match = end.exec(text))) {
    values.push(JSON.parse(text.slice(start, match.index + 1)));
    start = match.index + 1;
  }
  if (text.slice(start).trim()) throw new Error('unterminated go list output');
  return values;
}
function stripVariant(importPath) { return importPath.replace(/ \[[^\]]*\]$/, ''); }
// The test main go list -test adds for a package p: "p.test", package main,
// in p's directory.
function isTestMain(entry, dirs) {
  return entry.Name === 'main' && entry.ImportPath.endsWith('.test') &&
    dirs.get(entry.ImportPath.slice(0, -'.test'.length)) === entry.Dir;
}
// The package a go list -test entry belongs to: "p [p.test]",
// "p_test [p.test]" and the test main "p.test" all test p.
function owner(entry, dirs) {
  if (entry.ForTest) return entry.ForTest;
  return isTestMain(entry, dirs) ? entry.ImportPath.slice(0, -'.test'.length) : stripVariant(entry.ImportPath);
}
// The workspace packages a change affects: each package holding a changed
// file, every package whose build or tests depend on one, and every package
// go list could not load. Anything the package graph cannot account for
// (a manifest, a removed package, a file outside every package) makes every
// package affected, with the reason. changed holds absolute paths; exists
// tells a removed file from a present one; owners names, for a file, the
// package directories declared to read it at run time (a test reading
// ../../docs), in addition to the package that holds it.
function affectedPackages({root, modules, entries, changed, exists, owners = () => []}) {
  const listed = entries.filter(entry => !entry.ForTest && !/ \[/.test(entry.ImportPath) && entry.Module && entry.Module.Main);
  const dirs = new Map(listed.map(entry => [entry.ImportPath, entry.Dir]));
  const packages = new Map();
  for (const entry of listed) {
    if (isTestMain(entry, dirs)) continue;
    const embeds = [...(entry.EmbedFiles || []), ...(entry.TestEmbedFiles || []), ...(entry.XTestEmbedFiles || [])];
    packages.set(entry.ImportPath, {dir: entry.Dir, module: entry.Module.Dir,
      embeds: new Set(embeds.map(file => path.join(entry.Dir, file)))});
  }
  const byDir = new Map([...packages].map(([importPath, info]) => [info.dir, importPath]));
  const moduleDirs = new Set(modules.map(module => module.Dir));
  const direct = new Set();
  for (const file of changed) {
    const name = path.basename(file), dir = path.dirname(file);
    if (WORKSPACE_MANIFESTS.has(name) && dir === root) {
      return {full: true, reason: 'the workspace manifest ' + name + ' changed'};
    }
    if (MODULE_MANIFESTS.has(name) && moduleDirs.has(dir)) {
      return {full: true, reason: 'the module manifest ' + path.relative(root, file) + ' changed'};
    }
    const declared = owners(file);
    for (const owned of declared) {
      if (!byDir.has(owned)) throw new Error('go-owners names ' + (path.relative(root, owned) || '.') + ', which holds no package');
      direct.add(byDir.get(owned));
    }
    if (byDir.has(dir)) { direct.add(byDir.get(dir)); continue; }
    const owning = ownerByTestdataOrEmbed(file, byDir, packages);
    if (owning) { direct.add(owning); continue; }
    if (declared.length) continue;
    if (file.endsWith('.go') && !exists(file)) {
      return {full: true, reason: 'a Go file outside every remaining package was removed: ' + path.relative(root, file)};
    }
    return {full: true, reason: 'no package owns ' + path.relative(root, file)};
  }
  const affected = new Set(direct);
  for (const entry of entries) {
    const name = owner(entry, dirs);
    if (!packages.has(name)) continue;
    if (loadFailed(entry)) { affected.add(name); continue; }
    if ((entry.Deps || []).some(dep => direct.has(stripVariant(dep)))) affected.add(name);
  }
  return {full: false, reason: direct.size ? direct.size + ' changed package(s) and their dependents' : 'no package changed',
    packages: [...affected].sort().map(importPath => ({importPath, ...packages.get(importPath)}))};
}
// A package go list could not load is affected whatever changed, so its
// failure surfaces. One whose files the build tags exclude is not broken.
function loadFailed(entry) {
  const excluded = error => /build constraints exclude all Go files/.test((error && error.Err) || '');
  return Boolean(entry.Error && !excluded(entry.Error)) || (entry.DepsErrors || []).some(error => !excluded(error));
}
// A file in a package's testdata tree, or one the package embeds from a
// subdirectory, belongs to that package.
function ownerByTestdataOrEmbed(file, byDir, packages) {
  for (const [importPath, info] of packages) {
    if (info.embeds.has(file)) return importPath;
  }
  let dir = path.dirname(file), testdata = false;
  for (;;) {
    if (path.basename(dir) === 'testdata') testdata = true;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
    if (testdata && byDir.has(dir)) return byDir.get(dir);
  }
}
// Per module, the package directories to run on, relative to the module
// ("." or "./a/b"), keyed by the module's directory relative to the Go root.
// A full run lists "./..." for every module.
function byModule(root, modules, result) {
  const key = dir => path.relative(root, dir).split(path.sep).join('/') || '.';
  const out = {};
  if (result.full) {
    for (const module of modules) out[key(module.Dir)] = ['./...'];
    return out;
  }
  for (const pkg of result.packages) {
    const relative = path.relative(pkg.module, pkg.dir).split(path.sep).join('/');
    (out[key(pkg.module)] ||= []).push(relative ? './' + relative : '.');
  }
  return Object.fromEntries(Object.keys(out).sort().map(module => [module, out[module].sort()]));
}
// The affected packages as go command arguments from the Go root: import
// paths, or each module's path/... for a full run. Naming packages puts go
// test in package list mode, where it caches results, so an affected package
// whose test inputs did not change replays from the test cache.
function importArgs(modules, result) {
  if (result.full) return modules.map(module => module.Path + '/...');
  return result.packages.map(pkg => pkg.importPath);
}
// Package directories relative to the Go root, as scope job patterns match them.
function rootDirs(root, result) {
  return result.packages.map(pkg => {
    const relative = path.relative(root, pkg.dir).split(path.sep).join('/');
    return relative ? './' + relative : '.';
  });
}
module.exports = {LIST_FIELDS, affectedPackages, byModule, importArgs, owner, parseStream, rootDirs, stripVariant};
