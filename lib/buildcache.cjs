'use strict';
// BuildKit cache references for one build: where it imports layers from and
// where it exports them, in a registry the job is logged in to, or in the
// GitHub cache when it names none.
//
// A registry cache has no branch scoping of its own, so the reference carries
// it: the default branch writes the base tag, every other ref writes its own
// tag and reads its own before the default branch's. A pull request can then
// never change the layers a default-branch build imports, as with GitHub's
// cache, whose scoping the gha backend keeps.

const REGISTRY = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
// The distribution reference grammar for a repository path.
const REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_LENGTH = 128;

// A tag-safe form of free text: lower case, runs of anything else as one dash.
function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

function platformList(raw) {
  return [...new Set(String(raw || '').split(/[\s,]+/).map(p => p.trim()).filter(Boolean))].sort();
}

// The ref a run writes for: '' for the default branch, otherwise the pull
// request or branch it belongs to.
function refScope(event) {
  if (event.name === 'pull_request' || event.name === 'pull_request_target') {
    if (!Number.isSafeInteger(event.number) || event.number <= 0) throw new Error('A pull request event without a number');
    return 'pr-' + event.number;
  }
  if (event.name === 'merge_group') return 'merge-group';
  const branch = (event.ref || '').startsWith('refs/heads/') ? event.ref.slice('refs/heads/'.length) : '';
  if (branch && branch === event.defaultBranch) return '';
  if (branch) return 'branch-' + slug(branch);
  // A tag or detached ref writes nothing other runs read.
  return 'ref-' + slug(event.ref || 'unknown');
}

function tag(...parts) {
  const value = parts.filter(Boolean).join('--');
  if (!value || value.length > TAG_LENGTH || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error('Cache tag ' + JSON.stringify(value) + ' is not a valid tag of at most ' + TAG_LENGTH + ' characters');
  }
  return value;
}

// nodes: the builder's node count. Each node exports the cache to the same
// reference and the last to finish wins, so a multi-platform build split
// across nodes would keep one platform's layers.
function buildCache({registry, repository, scope, platforms, mode, nodes, event}) {
  if (!['max', 'min'].includes(mode)) throw new Error('mode must be max or min');
  const list = platformList(platforms);
  if (list.length > 1 && nodes > 1) {
    throw new Error('A cache for ' + list.join(', ') + ' on a builder with ' + nodes + ' nodes would keep only the ' +
      'platform of the node that exports last: build each platform in its own invocation with its own platforms input');
  }
  const base = slug(scope);
  if (!base) throw new Error('scope must contain a letter or digit');
  const variant = list.map(p => slug(p.replace(/\//g, '-'))).join('_');
  const own = refScope(event);
  const write = tag(base, variant, own);
  const shared = tag(base, variant);
  const reads = own ? [write, shared] : [write];
  if (!registry) {
    if (repository) throw new Error('repository needs a registry');
    // GitHub's cache scopes writes to the ref and reads the default branch's
    // itself, so the scope names only the build.
    return {
      backend: 'gha',
      cacheFrom: ['type=gha,scope=' + shared],
      cacheTo: 'type=gha,scope=' + shared + ',mode=' + mode + ',ignore-error=true'
    };
  }
  if (!REGISTRY.test(registry)) throw new Error('registry must be a host[:port], without a scheme or path');
  if (!REPOSITORY.test(repository || '')) throw new Error('repository must be a lower-case repository path, such as project/buildcache/image');
  const ref = registry + '/' + repository;
  return {
    backend: 'registry',
    cacheFrom: reads.map(t => 'type=registry,ref=' + ref + ':' + t),
    // image-manifest stores the cache as an OCI image manifest, which
    // registries that refuse BuildKit's cache index (Harbor among them)
    // accept; ignore-error keeps a failed export from failing the build.
    cacheTo: 'type=registry,ref=' + ref + ':' + write + ',mode=' + mode +
      ',image-manifest=true,oci-mediatypes=true,ignore-error=true'
  };
}

// The node count `docker buildx inspect` prints for a builder.
function nodeCount(inspectOutput) {
  const nodes = inspectOutput.split('\n').filter(line => /^Name:\s/.test(line)).length - 1;
  if (nodes < 1) throw new Error('Could not read the builder\'s nodes from docker buildx inspect');
  return nodes;
}

module.exports = {buildCache, nodeCount, refScope, slug};
