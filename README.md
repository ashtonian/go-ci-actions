# Go CI actions

Install Go and reuse fresh module/build caches across ephemeral GitHub Actions
runners. This action wraps commit-pinned official setup-go and cache actions.
It supports Go workspaces, workload matrices, Linux and macOS. Runner 2.338.0
or later is required, including on self-hosted runners.

Use ashtonian/go-ci-actions@FULL_COMMIT_SHA after checkout, with go-version-file
or go-version, and workload for matrix variants. Consumers pin a reviewed commit;
immutable version tags identify releases.

## Interface

Optional inputs: go-version (empty), go-version-file (go.mod), check-latest
(false), workload (empty), cache-dependency-path (empty: the manifests under
go-version-file's directory, see Policy), cache-mode (read-write),
cache-key-prefix (go-v1), seed-from-other-workloads (true),
max-staleness-hours (2), build-cache-backend (auto), module-proxy (auto) and
test-input-mtimes (content, see Test results across checkouts).

Set cache-mode to read-only to restore without pruning or saving; off installs
Go without restoring or saving caches, and leaves the checkout's file times
alone. Include matrix variants, build flags and external C library versions in
workload. Go does not detect changes to cgo system libraries. Keep forced
execution (`-count=1`) for integration, benchmark and other
environment-dependent checks in caller workflows.

Outputs: go-version, actual-toolchain, build-cache-backend (github, remote or
off), module-proxy (the runner proxy in use, or empty), cache-primary-key
(empty when nothing is archived, which includes cache-mode off),
cache-matched-key, cache-hit, test-input-mtimes (content when the checkout's
tracked files carry content-derived times, off otherwise). A prefix restore
provides reuse even when cache-hit is false.

## Policy

Keys include runner OS/architecture, resolved GOVERSION, a digest of
workflow/job/workload, manifests, run ID and run attempt. Successful jobs save
fresh state. Restore order is same workload/manifests, same workload with older
manifests, then a compatible compiler seed when enabled. GitHub enforces branch
and repository cache scope; sharing action code does not share cached contents.

The manifest digest is computed only when something is archived (see the table
under Module proxy); a job whose build objects and modules both come from the
runner reads no manifests at all. With cache-dependency-path empty it covers
every go.mod, go.sum, go.work and go.work.sum under the directory holding
go-version-file, so sibling checkouts elsewhere in the workspace neither slow
setup nor change the key; with the default go-version-file that directory is
the workspace root. Explicit patterns are relative to the workspace, one per
line, `!` excludes matches and `#` starts a comment. Either way `**` does not
enter dot-directories or symlinked directories, `node_modules` is skipped, and
a pattern or go-version-file outside the workspace fails setup. The digest is a
SHA-256 over each matched file's SHA-256 in sorted path order; no match gives
an empty digest. The identity step logs how many manifests it hashed.

Before successful post-save, build objects unused since setup began are pruned
with two hours of slack for Go's mtime-touch granularity. Long jobs retain
objects used early. Module source is not age-trimmed. The post step walks only
the directories the archive holds and does not run when nothing is archived.
Logs and job summaries report restored/missed state, module/build bytes (`not
archived` for a directory the archive does not hold), trimmed bytes and
maintenance time. Official cache logs report transfer timing.

## Remote build cache

A self-hosted runner can provide a shared build cache: it sets
GOCACHEPROG_REMOTE_URL and puts a `gocacheprog`
[GOCACHEPROG](https://pkg.go.dev/cmd/go/internal/cacheprog) plugin on PATH.
With build-cache-backend auto (the default) the action then exports
GOCACHEPROG, and GOCACHEPROG_DIR under RUNNER_TEMP unless the runner sets one.
The plugin serves and stores build objects; the GitHub cache keeps only the
module cache. Without both signals, or with build-cache-backend github, build
objects stay in the GitHub cache. A GOCACHEPROG inherited from the runner is
cleared then, and in off mode, so each mode means what it says.

Linters keep their caches there too. With the remote backend the action also
exports GOLANGCI_LINT_CACHEPROG as the same plugin (unless the job sets it), so
golangci-lint v2.13 and later stores its analysis cache through the plugin;
staticcheck 2026.2 and later reads GOCACHEPROG itself. Both then hit across
runners on the same terms as build objects: their keys cover sources,
dependencies, the linter version and configuration, and the entries another
ref can read come only from runs on a trusted ref (see *Who fills the shared
cache*). golangci-lint (v2.15.0, `computeGoModSalt`) also salts every key with
the run's `--build-tags` and the whole content of the module's `go.mod`: lint
runs with different tags share no analyses, and any change to a module's
`go.mod`, a comment included, re-lints that module cold until a trusted-ref run
stores its new entries. Measured in a Karsto pull request that bumped one
dependency in its `go.mod`: every lookup for that module missed.

Job containers can consume the same runner-owned setup through the mounted
tool cache. Before accepting a job, the runner places a native executable at
`$RUNNER_TOOL_CACHE/go-ci-cache/v1/gocacheprog` and writes `config.json` beside
it with
`{"version":1,"remoteURL":"https://cache.example","moduleProxyURL":"http://proxy.example:3000","npmRegistryURL":"http://npm.example:4873"}`;
every endpoint is optional (see Module proxy and npm registry cache). Use a real copy of the
executable: links into the host image do not resolve in a job container.
Endpoints must be HTTP(S), without embedded credentials, a fragment, commas or
pipes. The bundle contains no token; uploads still use the current job's OIDC
authorization.

Auto mode discovers this bundle when the environment/PATH contract is absent.
An explicit endpoint takes precedence. A missing bundle or helper retains the
GitHub backend; a malformed manifest fails setup. Explicit github/off modes
ignore the bundle. The runner owns its contents and lifetime; the action does
not download a helper or infer a site endpoint.

| cache-mode | Plugin | GitHub cache (modules) |
| --- | --- | --- |
| read-write | Reads and uploads | Restores; saves on success |
| read-only | GOCACHEPROG_READ_ONLY=true | Restores only |
| off | Not used | Not used |

Uploads need the job's OIDC token: grant `permissions: id-token: write`.
Without it the plugin reads only, and the action logs a notice. What a token
lets a job write is the cache service's policy, not this action's.

Module archives are keyed by OS, architecture, workload digest and manifests,
without the run ID or compiler. Module content is fixed by the manifests, so
each workload saves once per manifest set instead of once per run. Restores
fall back to the same workload's older manifests, then (with
seed-from-other-workloads) to any workload's archive. The local plugin
directory is per job and is not trimmed, measured or archived;
max-staleness-hours applies to the GitHub backend only.

## Test results across checkouts

`go test` replays a passing package's result from the build cache when nothing
it depends on changed. The key covers the test binary (the package, every
dependency, build flags, toolchain), the cacheable test flags, the environment
variables the test read, and every file inside the module it opened or
stat'ed, recorded by absolute path, size, mode and modification time, not by
content (`cmd/go/internal/test`, `hashOpen`). A file modified less than two
seconds before the run disables caching for that package. `actions/checkout`
writes every file at checkout time, so with checkout times no package whose
tests read `testdata` ever matches a result recorded in another job, even
though its compiled objects hit the shared cache.

With test-input-mtimes `content` (the default), setup gives every tracked file
and symbolic link in the Git work tree holding go-version-file a modification
time derived from its bytes, after checkout and before any test runs:

- **Derivation.** SHA-256 over a versioned prefix and the file's bytes (a
  link's target path for a symbolic link); the first 48 bits become
  2000-01-01T00:00:00Z plus 29 bits of seconds and 19 bits of binary fraction.
  Every time falls between 2000 and 2017: years older than the two-second
  cutoff, and inside 32-bit seconds. The fraction is exact as a double and
  survives Node's microsecond timestamps, so identical bytes give an identical
  time in every checkout on every runner, and adjacent fractions stay
  distinct. Go also keys on size, so a false match needs two different
  contents of the same size at the same path whose 48 bits collide:
  probability 2^-48 per pair (2^-29 on a filesystem that stores whole
  seconds). The runners' ext4/XFS and APFS store nanoseconds.
- **Directories.** Every directory holding a stamped path (and the work tree
  root) gets 2000-01-01T00:00:00Z exactly. Go hashes a directory it reads by
  its own stat plus every entry's name and stat, so a constant directory time
  still sees an entry added, removed or changed.
- **What is on disk now.** The time comes from the file's current bytes, not
  from the index, so a file a step changed before setup gets its new content's
  time. A file written after setup gets the time of that write, which misses
  (and inside two seconds is not cached at all): conservative. Copies that
  preserve times (`cp -p`, `tar`) keep a content-derived time with its
  content. Nothing may write tracked files while setup runs.
- **Left alone.** Untracked and ignored files (generated during the job, so
  tests reading them re-execute), submodule contents (another repository's
  index), index entries absent from disk (sparse checkouts), sibling
  checkouts in the workspace other than go-version-file's, and files this user
  may not re-time. A workspace without Git, or a work tree outside the
  workspace, is logged as a notice and left unchanged.
- **Git's index.** The index caches each file's stat, so setup refreshes it
  (`git update-index -q --refresh`) after stamping; without that, plumbing
  such as `git diff-index --quiet HEAD` would report every file as changed. A
  file that differs from the index still shows as modified.

The log line reports the files, links and directories stamped and the time
taken. The cost is one read of the tracked bytes by setup plus one by Git's
refresh, which rehashes every re-timed file: in a Linux container on 4 CPUs,
a 62,950-file, 952 MB checkout (gox, 921 MB of it `bench-results/`) took
3.0 s, 2.0 s of it the refresh; this repository's checkout takes tens of
milliseconds. A job that runs no `go test` can set test-input-mtimes `off`.

**What callers keep forced.** Content-derived times make a cached result as
trustworthy as the files Go can see. A test whose outcome depends on anything
else must keep `-count=1`: databases, containers, network services, processes
it starts, the installed `git` or other tools, the wall clock, kernel features
(io_uring availability, cgroups), hardware, randomness it does not seed, and
files outside the module. Integration, E2E, benchmark and fuzz lanes keep
`-count=1`. A flag outside go test's cacheable set (`-benchtime`,
`-coverprofile`, `-cpu`, `-failfast`, `-fullpath`, `-list`, `-outputdir`,
`-parallel`, `-run`, `-short`, `-skip`, `-timeout`, `-v`) disables result
caching for the run: `-count=1` by convention, but also `-bench`, `-shuffle`
and `-args`. Build flags such as `-race`, `-tags` and `-trimpath` are part of
the test binary's identity and keep caching.

**Who fills the shared cache.** A run with `-count=1` stores no result, and
a remote cache that scopes writes by ref (the site's gate: trusted refs write
the namespace every ref reads, any other ref only its own) keeps a pull
request's results to that pull request. Results another pull request can
reuse therefore come only from a cacheable run on a trusted ref. When pushes
to the default branch skip work a pull request already passed (`acceptance`)
or a change does not touch (`scope`), that run is the nightly. Make the
nightly the backstop and the filler at once: run `go clean -testcache` first,
then the same cacheable command the pull requests run. Every earlier result
is then expired, so every test executes, and the results it stores are what
the next day's pull requests replay. Measured on this repository's fixture:
after `go clean -testcache` the next run executed and the one after replayed
`(cached)`, while a `-count=1` run on a fresh cache left the next cacheable
run to execute again. Environment-dependent lanes keep `-count=1` in the
nightly too.
`go test -json` replays cached packages with their `run`/`pass` events, so
inventories built from `-json` keep working.

**The make hazard.** Content-derived times are years in the past. A tool that
decides freshness by comparing a tracked input's time with an output restored
from a cache (make, `tsc --build`, Cargo's local-crate fingerprints) sees every
restored output as newer than its inputs and skips the rebuild even when the
input changed. Checkout times hide this today because every input looks new.
Before adopting this release, a caller checks its rules that compare tracked
inputs with outputs restored from actions/cache or another job, and sets
test-input-mtimes `off` on those jobs (or removes the restored outputs).
Outputs a job builds itself are unaffected: they are newer than any stamped
input. Two tracked files compared with each other (a checked-in generated file
and its source) have an arbitrary but stable order, as with checkout times,
whose order follows checkout order.

## Module proxy

A self-hosted runner can provide a Go module proxy (the
[GOPROXY protocol](https://go.dev/ref/mod#goproxy-protocol)): it sets
GO_MODULE_PROXY_URL, or `moduleProxyURL` in the bundle for job containers; the
variable wins. With module-proxy auto (the default) the action asks the proxy
for `/readyz`, which must answer 200 within 3 seconds, and on success exports

```text
GOPROXY=<proxy>|<the job's go env GOPROXY>
```

`|` makes the go command move to the next entry on any error, so a proxy that
fails mid-job costs speed, not the build. Checksum verification is unchanged:
go.sum and GOSUMDB still check every module, and GOPRIVATE paths still skip
every proxy. Modules then stay out of the GitHub cache:

| Build cache | Module proxy | GitHub cache holds | Key namespace |
| --- | --- | --- | --- |
| remote | ready | nothing; restore and save are skipped | none (empty key) |
| github | ready | build objects | `<prefix>-build-…` |
| remote | none, off or not ready | modules | `<prefix>-mod-…` |
| github | none, off or not ready | build objects and modules | `<prefix>-…` |

The action leaves GOPROXY alone, and archives modules as before, when the job
sets GOPROXY itself, when `go env GOPROXY` is `off`, with module-proxy off, or
when the proxy is absent or fails the probe; the last logs a notice naming the
proxy and the failure. A malformed endpoint fails setup. The proxy decision
does not depend on cache-mode: off disables the GitHub cache and the build
plugin, not the module source. Only a ready proxy is used, because every
module request tries it first: a dead one that drops connections would stall
each request before the fall-through.

The go-v1 namespace and workload digest preserve existing local-helper warm
caches. Empty manifest sets are supported for scaffold-generation jobs.
Cache paths must not contain credentials.

## npm registry cache

`ashtonian/go-ci-actions/npm-registry@FULL_COMMIT_SHA` points pnpm, npm and
Corepack at a registry cache the self-hosted runner provides (any npm registry
server, such as Verdaccio). The runner sets NPM_REGISTRY_CACHE_URL, or
`npmRegistryURL` in the bundle for job containers; the variable wins. Run it
before installing the package manager and before any install step:

```yaml
- uses: ashtonian/go-ci-actions/npm-registry@FULL_COMMIT_SHA
- uses: pnpm/action-setup@<sha>
- run: pnpm install --frozen-lockfile
```

With mode auto (the default) the action asks the cache for `/-/ping`, which
must answer 200 within 3 seconds, and on success exports

```text
pnpm_config_registry=<cache>/
npm_config_registry=<cache>/
COREPACK_NPM_REGISTRY=<cache>
```

pnpm 11 and later read `pnpm_config_*` and ignore `npm_config_*`, so both are
set. Neither client falls back to a second registry within a run, which is why
only a cache that answers is used: one that does not leaves the job on the
registry it already configures, with a notice naming the cache and the failure.
The action changes nothing when the job's environment already names a registry
in any of those variables (either case), with mode off, or when the runner
provides no cache. Scoped registries and credentials in `.npmrc` keep applying.
Lockfiles are unaffected: they record integrity hashes, which the client checks
whichever registry served the tarball. A malformed endpoint fails the step.

Output: `registry` (the cache URL in use, or empty).

## Native multi-arch builder

`ashtonian/go-ci-actions/buildx-native@FULL_COMMIT_SHA` selects a buildx
builder with one native node per architecture for the rest of the job:
linux/amd64 on a BuildKit started in the job's own Docker daemon, and
linux/arm64 on a remote arm64 BuildKit reached over mutual TLS. A
multi-platform `docker buildx build` (or GoReleaser, or
docker/build-push-action) then runs each platform's `RUN` steps on its own CPU,
with no QEMU. Runners that cannot register binfmt handlers need this for any
arm64 image whose build executes arm64 code.

The runner supplies the arm64 BuildKit, as it supplies the build cache:
`BUILDKIT_ARM64_ENDPOINT` (`tcp://host:port`) and `BUILDKIT_ARM64_TLS_DIR`
(a directory holding `ca.crt`, `tls.crt` and `tls.key`). The `arm64-endpoint`
and `arm64-tls-dir` inputs override them. The TLS server name is the
endpoint's host. The action fails before creating anything when either is
missing or a certificate file is unreadable, so a runner without the client
certificate reports that instead of a later TLS error.

```yaml
- uses: ashtonian/go-ci-actions/buildx-native@FULL_COMMIT_SHA
- run: docker buildx build --platform linux/amd64,linux/arm64 .
```

Output: `name`, the builder, which is also the job's current builder. The
action sets `BUILDX_CONFIG` to an empty directory for the rest of the job: the
remote driver refuses a BuildKit config file, and later buildx calls read the
selection from there. Use it once per job. A Dockerfile that cross-compiles in
`$BUILDPLATFORM` stages should keep a single amd64 builder, because on this
builder its compile stage would run on the arm64 node.

## BuildKit cache

`ashtonian/go-ci-actions/buildx-cache@FULL_COMMIT_SHA` gives one image build
its BuildKit `cache-from` and `cache-to` entries: a registry cache in a
registry the job is already logged in to, or GitHub's cache when it names no
registry.

```yaml
- uses: docker/login-action@<sha>
  with: {registry: "${{ secrets.HARBOR_REGISTRY }}", username: ..., password: ...}
- id: cache
  uses: ashtonian/go-ci-actions/buildx-cache@FULL_COMMIT_SHA
  with:
    registry: ${{ secrets.HARBOR_REGISTRY }}
    repository: karsto/buildcache/server
    platforms: linux/amd64
- uses: docker/build-push-action@<sha>
  with:
    platforms: linux/amd64
    cache-from: ${{ steps.cache.outputs.cache-from }}
    cache-to: ${{ steps.cache.outputs.cache-to }}
```

A registry has no branch scoping of its own, so the tag carries it. The
default branch (pushes, schedules and dispatches on it) writes and reads
`<scope>`; a pull request writes `<scope>--pr-<number>` and reads it, then
`<scope>`; any other branch does the same with `branch-<name>`, a merge group
with `merge-group`. A pull request therefore never changes the layers a
default-branch build imports, which is the isolation GitHub's cache gives. The
export is an OCI image manifest (`image-manifest=true,oci-mediatypes=true`),
which Harbor stores where it refuses BuildKit's default cache index, with
`ignore-error=true` so a failed export does not fail the build; a missing or
unreadable import is a cold build. Without a registry the entries are
`type=gha,scope=<scope>` (GitHub scopes them by branch itself).

Platforms name the cache too: `platforms: linux/amd64` writes
`<scope>--linux-amd64`. On a builder with more than one node, such as
[buildx-native](#native-multi-arch-builder)'s, every node exports its own
platform's cache to the same reference and the last to finish wins: measured
on a two-node builder, a cold rebuild reused the amd64 layers and re-ran every
arm64 step. The action therefore refuses more than one platform on a
multi-node builder (it reads `docker buildx inspect`); build each platform in
its own invocation with its own `platforms` and combine the digests
(`docker buildx imagetools create`). A single-node builder exporting several
platforms writes them in one manifest and is accepted.

Inputs: `registry` (host, no scheme; empty uses `type=gha`), `repository`
(required with a registry: a lower-case path, by convention
`<project>/buildcache/<image>`, so a retention rule can match the cache
repositories alone), `scope` (default the job ID), `platforms` (comma- or
newline-separated, default empty), `mode` (`max`, every stage's layers, or
`min`) and `builder` (default the current one). Outputs: `cache-from` (one
entry per line, as build-push-action takes it; repeat `--cache-from` per line
for `docker buildx build`), `cache-to` and `backend` (`registry` or `gha`).

Credentials and reach are the runner's and the repository's, not this
action's: the job logs in to the registry with a robot that may push to the
project, and the builder's nodes must reach the registry and its layer
storage. In the site's runners that is Harbor for the private sets; public
sets, whose egress excludes the LAN, use GitHub's cache.

## Change scope

`ashtonian/go-ci-actions/scope@FULL_COMMIT_SHA` decides which of a workflow's
jobs a change needs and, for Go jobs, which packages they check. It runs first,
in a job the others need, and is how a repository follows "CI runs only on what
changed".

- **Base.** A pull request is measured from the base its merge commit merges
  into (the first parent of the checked-out merge; the event's base SHA when
  the checkout is not that merge, which can only widen the diff). A merge
  group is measured from its `base_sha`. A push to a branch is measured from
  the head of the newest successful run of the same workflow file on that
  branch (this repository, not the running run; the newest `lookback` (20)
  are consulted), so a push whose predecessor failed or was cancelled still
  checks that predecessor's changes. Only `push` and `schedule` runs count:
  a push ran the scope measured from an earlier base and a schedule ran
  everything, while a `workflow_dispatch` can narrow its work through inputs
  the scope never sees (a fast-runner dispatch), so a green one is no base.
  acceptance's green-base check counts the same runs. A push run must not
  narrow its jobs by anything but the scope's outputs, or this induction
  breaks. A shallow checkout is enough: the base commit is
  fetched with the job token when it is missing.
- **Full runs.** `workflow_dispatch`, a pull request labelled `full-label`
  (`full-ci`), `full: true`, a tag push and any other event run every job and
  every package. A `schedule` run does too, unless the newest green scheduled
  run on the branch of the workflow the schedule triggers (the caller, when
  this is a reusable workflow) was on this same commit: then the branch has
  not moved since the last green nightly and nothing runs. So does
  anything the scope cannot decide: no green run to compare with, a
  run-history API error, a base that cannot be fetched or diffed. Those log a
  warning and set `reason`.
- **Jobs.** `jobs` maps each job ID to its inputs: path globs, Go package
  patterns, or both. A job runs when one of its paths changed or one of its Go
  packages is affected. A Go job's paths are its own configuration and
  scripts (a linter config, a test script), so when one of them selects it
  the job checks every package; `wide-jobs` lists those jobs. A change to any `shared` path (workflow files, CI
  scripts, the files that pin the toolchain) runs every job. Globs are
  repository-relative: `**` as a whole segment spans directories, `*` and `?`
  stay within a segment, dot files match, everything else is literal. In a
  job's `paths`, `shared` and `go-ignore`, a glob starting with `!` excludes:
  a file matches the list when it matches one of its globs and none of its
  `!` globs, wherever they appear (dorny/paths-filter's `some-with-excludes`),
  for example `["karsto/**", "!karsto/web/**", "!**/*.md"]`. A list of only
  `!` globs fails the step.
- **Go packages.** When a job names Go package patterns (`./...`, `./dir/...`,
  `./dir`, `.`, relative to `go-directory`), the scope loads the package graph
  of every module in the workspace with `go list -e -test` (with `go-tags`),
  once per `go-builds` configuration, unioned, and computes the affected
  packages: each package that holds a changed file,
  plus every package whose build or tests depend on one, across modules. A
  file belongs to the package of its directory, of an ancestor whose
  `testdata` tree holds it, or that embeds it. A package that fails to load is
  always affected; one whose files the tags exclude is not broken. A test
  that reads a file outside its package at run time (`../../docs/*.md`)
  declares it in `go-owners`, which maps a glob to the package directories
  that read it; a change to such a file affects them too. Every package is
  affected when a module's go.mod or go.sum, go.work or go.work.sum changes,
  when a removed Go file leaves no package behind, when `go list` fails, or
  when a changed file outside `go-ignore` belongs to no package and no
  `go-owners` entry: list documentation and other files no Go code reads in
  `go-ignore`, never code inputs. Grep the tests for `ReadFile`, `Open` and
  `Glob` of relative paths before narrowing either list.
- **Binaries.** A job that tests built binaries (a compliance suite, a soak,
  a release snapshot) names them in `go-binaries` (`["./cmd/estavelled"]`,
  relative to `go-directory`) instead of `go`. It runs when a file the
  binaries' build reads changed: the GoFiles, CgoFiles, SFiles, CFiles,
  HFiles, SysoFiles and EmbedFiles of every package in their `go list -deps`
  closure that lives in the checkout, their modules' go.mod and go.sum, and
  go.work. A change to a test file or testdata does not select it; its own
  harness goes in its `paths`. Every changed file counts, `go-ignore`d ones
  too, since a binary can embed a document. A full Go scope (a manifest, an
  unowned file, `go list` failing) or a closure that does not load selects it.
  Its selection is `"all"`: it checks the binaries whole. A job names `go` or
  `go-binaries`, not both.
- **Build configurations.** A repository that builds for several platforms or
  tag sets lists them, and the scope loads one graph per `go-builds` line and
  `go-tags` line, every pair, and unions them. `go-builds` lines are
  `KEY=VALUE` pairs from GOOS, GOARCH, GOARM, GOAMD64, GOARM64, CGO_ENABLED,
  GOEXPERIMENT and `tags=a,b` (added to every tag set), for example
  `GOOS=linux GOARCH=amd64` and `GOOS=darwin GOARCH=arm64`; none is the
  runner's own platform. `go-tags` lines are tag sets (`unit,integration`;
  `-` is the empty set); one line is one set, and none is no tags. List each
  set a constraint can tell apart: a superset does not cover a file behind
  `!integration`. In the union a package that builds only for one platform or
  tag set is owned and its dependents found, and an error only some
  configurations hit (build constraints excluding every file) does not make
  it broken. Each configuration is one `go list` over the workspace, about a
  second on a dozen-module workspace once modules are in the cache.

The job IDs in `jobs` are the workflow's job IDs, and the jobs gate on the
scope job's output with `contains(needs.scope.outputs.jobs, '"<id>"')` (a
string test, so a skipped scope job selects nothing rather than failing the
expression). A job that runs only on its paths or packages of a larger group,
such as a matrix or a chain, gates on the ID of the job that aggregates it, so
push acceptance (below) can match it against the pull request's results.

```yaml
jobs:
  scope:
    runs-on: <runner>
    permissions: {contents: read, actions: read, id-token: write}
    env:
      CI_ARTIFACT_ENDPOINT: ${{ secrets.CI_ARTIFACT_ENDPOINT }}
    outputs:
      jobs: ${{ steps.accepted.outputs.remaining || steps.scope.outputs.jobs }}
      selections: ${{ steps.scope.outputs.selections }}
      wide-jobs: ${{ steps.scope.outputs.wide-jobs }}
      go-packages: ${{ steps.scope.outputs.go-packages }}
    steps:
      - uses: actions/checkout@<sha>
        with: {persist-credentials: false}
      - uses: ashtonian/go-ci-actions@FULL_COMMIT_SHA # Go for the package graph
      - id: scope
        uses: ashtonian/go-ci-actions/scope@FULL_COMMIT_SHA
        with:
          jobs: |
            {
              "test": {"go": ["./..."]},
              "image": {"paths": ["Dockerfile", ".dockerignore"], "go": ["./cmd/app"]},
              "docs": ["docs/**", "**/*.md"]
            }
          shared: |
            .github/workflows/ci.yml
            scripts/ci/**
          go-ignore: |
            docs/**
            CHANGELOG.md
      - id: accepted
        if: github.event_name == 'push'
        uses: ashtonian/go-ci-actions/acceptance@FULL_COMMIT_SHA
        with:
          mode: verify
          required: ${{ steps.scope.outputs.jobs }}
          base: ${{ steps.scope.outputs.base }}
          selections: ${{ steps.scope.outputs.selections }}
          variables: ${{ toJSON(vars) }}
  test:
    needs: scope
    if: contains(needs.scope.outputs.jobs, '"test"')
    steps:
      - env:
          # {"<module dir>": ["./pkg", "."]}: go test each module's list, or
          # every package when the job is in wide-jobs.
          PACKAGES: ${{ contains(needs.scope.outputs.wide-jobs, '"test"') && 'all' || needs.scope.outputs.go-packages }}
        run: ...
```

Inputs: `jobs` (required), `shared`, `full` (`false`), `full-label`
(`full-ci`), `workflow` (the workflow file whose green runs are a push's base;
default the running workflow, which in a reusable workflow is its caller),
`jobs-workflow` (the workflow file that defines the job IDs in `jobs`;
default `workflow`. A reusable workflow that scopes its own jobs while its
caller's runs are the trunk history leaves `workflow` empty and names itself
here; one whose own runs are the history, called by a release, sets
`workflow` to itself instead),
`lookback` (20, 1-100), `path` (`.`: the checkout's directory under the
workspace, as actions/checkout's `path`; git runs there and the workflow
files, every glob, `files` and `go-directory` are relative to it, so a
repository whose go.mod replaces siblings such as `../gox` can be checked out
at `estavelle/` beside them), `go-directory` (`.`), `go-tags` (tag sets, one
per line), `go-builds`,
`go-ignore`, `go-owners` (JSON, glob to package directories) and `token`
(`github.token`; needs `actions: read` for a push and `contents: read`).
Outputs: `full` (`true` when every job and package is in scope), `jobs` (JSON
array of the selected job IDs, in `jobs` order), `wide-jobs` (the selected
jobs that check every package), `selections` (JSON object of each selected
job to what it checks: the affected Go packages its patterns match, as import
paths, or `"all"` for a job that checks everything or has no Go patterns;
pass it to acceptance record and verify), `base`, `files` (a file
listing the changed paths, one per line; empty for a full run), `reason`,
`go-packages` (JSON object of module directory, relative to `go-directory`, to
the package directories to check relative to the module, `"./..."` for all;
modules with nothing affected are absent), `go-args` (the affected packages'
import paths, space-separated, or each module's `path/...` when every package
is in scope) and `go-reason`. `go-args` runs from `go-directory` as one `go
test` across a workspace's modules. Both forms name packages, which puts `go
test` in package list mode: it caches test results, so with the remote cache
an affected package whose test inputs did not change replays from cache
rather than running (flags such as `-count=1` turn that off). The lists hold
every affected package of the graph loaded with `go-tags`, including packages
that exist only under a tag or hold only test files. `go test` and `go vet
-tags ...` take them all; a command that names packages without the tags, or
`go build`, refuses those two kinds by name, so leave them out first (`go list
-e` reports a tag-only package's error, and a test-only one has no `GoFiles`).
golangci-lint reads its arguments as directories, not import paths: give it
`go-packages`' directories, or map `go-args` through `go list -f '{{.Dir}}'`. The log lists the
changed files, each job's decision and why, and the Go packages; the job
summary repeats the decision. Invalid `jobs`, globs or patterns fail the step,
and so does a job ID `jobs-workflow` does not define (a typo would otherwise
leave that job never selected).

When a job ran that should not have, or the other way round, read the scope
step's log: each job line names the file or package that selected it, and
`reason` and `go-reason` say what the change was measured from and why the Go
scope widened. A push that runs everything with `no green run of this workflow`
has no successful run within `lookback`; one with `diff against <sha> is
unavailable` could not fetch that commit (force-pushed away, or a token without
`contents: read`).

## Push acceptance

`ashtonian/go-ci-actions/acceptance@FULL_COMMIT_SHA` lets the push that merges
a pull request skip the checks the pull request already passed on the same
tree. A pull request run tests GitHub's merge commit of the head into the base;
when the merge button then pushes a merge commit with that tree, running the
same workflow file over it again repeats work whose result is known.

- **record** runs in the pull request, in a job that needs every validation
  job. It refuses unless the event is a pull request from this repository, the
  checkout is that pull request's merge commit (second parent the head), and
  no job in `results` failed or was cancelled. It stores a receipt,
  `acceptance.json`, as the run's `acceptance` artifact in SeaweedFS
  (seven-day retention): the repository, workflow file, run ID and attempt,
  the merge commit's SHA, parents and tree, a SHA-256 of the repository
  variables, the jobs that passed and the jobs that were skipped (by the
  run's scope or any other condition) as separate lists, and `selections`,
  what each job checked (the scope's output).
- **verify** runs first in the push. It outputs `reused=true` only when the
  push is the first attempt of a push to the default branch, the pushed commit
  is a merge whose first parent is the previous head (`before`), `base` (the
  scope's base) has a successful run of the same workflow file on the
  default branch (`green_base`), the latest pull request run of that workflow
  for the merge's second parent completed successfully within
  `max-age-hours` (6), that run's final attempt stored a
  receipt with the same tree, head, workflow file, variables digest, run ID
  and attempt, and every job in `required` passed in it having checked at
  least what the push's scope selects for it. `required` and `selections`
  are the push's own scope (the scope action's `jobs` and `selections`
  outputs). Reuse is per job: `remaining` lists the required jobs the push
  still runs, those the matching receipt does not show passed (a job the pull
  request skipped, such as a heavy suite it runs only with `full-ci`) or
  passed on a narrower selection, so the rest are skipped even when some must
  run; `reused` is true when none remain. Without a matching receipt
  on a green base `remaining` is every required job. With `required` empty,
  every job the receipt names must have passed and `remaining` is empty.
  Anything else, an API or storage error included, gives `reused=false` with
  the reason in `reason`, the log and the job summary, and the push's jobs
  run. Only invalid inputs fail the step.

Why this is sound. The push runs only `required` because every other job's
inputs are unchanged since `base`, the last green run of the workflow, so
`base` must be green. A required job the pull request passed on this tree is
reused only if the pull request checked at least what the push needs: a job
narrowed to the affected packages (or apps, or checks) checks a set measured
from the pull request's base, while the push's set is measured from `base`,
and when a red commit sits between them the push's set is larger. Push X
breaks package `state` and its run fails, so `base` stays before X; a pull
request on X touches only `media` and its `go` job tests `media`; the push
needs `state` and `media`, the receipt shows only `media`, and `go` runs. A
job's selection covers another when it is `"all"` or a superset; a job the
receipt has no selection for is not reused. With `base` the parent, both
sets are the same diff and every passed job is reused, as v1.8.0's green
parent did; with an older `base`, a job is reused only when the extra
commits touched nothing the pull request did not check.

**Compute `required` and `selections` with the scope action and pass its
`base`.** A job that narrows its work some other way (a step that runs only
some checks, a render of only the affected apps) puts what it checks in
`selections` itself, in both the pull request and the push. Without
`selections`, verify ignores `base` and requires the merge's parent to have a
green run, as in v1.8.0. With `base` empty, as when the scope selected every
job, each selection is `"all"` and there is nothing older to compare.
Unscoped (no `required`), the pull request ran every job on this tree and
nothing is checked. A failure with no input change (a flaky test, a new
vulnerability advisory) is in no scope; the nightly full run catches it.

**v1.10.0: do not pass `base`.** It reused a narrowed job against an older
`base` without comparing selections, so a red commit between `base` and the
parent could go unchecked. Upgrade to v1.11.0, or leave `base` out on v1.10.0
(it then checks the parent as v1.8.0 did).

Tree equality covers the workflow file and everything else in the repository.
Repository variables are compared through their digest; secrets, the runner
image and time-dependent inputs (a vulnerability database, a `1.27.x` toolchain
resolving to a newer patch) are not, which is what the age limit bounds and
the nightly full run catches. A squash or rebase merge, a direct push, a push
of several commits and an explicit rerun all run their scoped checks.

The record job needs every validation job and runs when none failed or was
cancelled:

```yaml
  accepted:
    needs: [scope, test, image, docs]
    # Explicit: with the default success(), a job the scope skipped would
    # skip this one too.
    if: ${{ github.event_name == 'pull_request' && !cancelled() && needs.scope.result == 'success' && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}
    runs-on: <runner>
    permissions: {contents: read, id-token: write}
    env:
      CI_ARTIFACT_ENDPOINT: ${{ secrets.CI_ARTIFACT_ENDPOINT }}
    steps:
      - uses: actions/checkout@<sha>
        with: {persist-credentials: false}
      - uses: ashtonian/go-ci-actions/acceptance@FULL_COMMIT_SHA
        with: {mode: record, results: "${{ toJSON(needs) }}", selections: "${{ needs.scope.outputs.selections }}", variables: "${{ toJSON(vars) }}"}
```

The verify step sits in the scope job (above). A workflow without a scope job
runs verify in a first job of its own, without `required`, and gates every
other job on `needs.<job>.outputs.reused != 'true'` with `!cancelled()` so
they still run when that job is skipped on pull requests.

Inputs: `mode` (`record` or `verify`, required), `results` (record:
`toJSON(needs)`), `path` (`.`, the checkout's directory, as for scope),
`required` (verify: a JSON array or one job ID per line),
`base` (verify: the scope's `base` output), `selections` (both modes: the
scope's `selections` output),
`variables` (`toJSON(vars)`, default `{}`; pass the same in both modes),
`workflow` (the workflow file holding the receipts, default the running
workflow; a workflow called with `workflow_call` sees its caller's file, so it
names its own, for example `ci.yml`), `name` (`acceptance`), `max-age-hours`
(`6`), `token` (`github.token`, needs `actions: read` for verify) and
`endpoint` (default `CI_ARTIFACT_ENDPOINT`). Both modes need the commit checked
out (a shallow clone is enough), `id-token: write` for the artifact gateway
and `CI_ARTIFACT_ENDPOINT` (a repository secret). Outputs (verify): `reused`,
`remaining` (JSON array of the required jobs to run; the scope job's `jobs`
output is `remaining || scope.jobs`, since verify does not run on pull
requests), `reason` and `green_base` (`true`, `false`, or empty when unscoped
or when verify stopped before asking). v1.10.0's `green_parent`, a
deprecated copy of `green_base`, is gone; read `green_base`. A consumer that
passes no `selections` keeps v1.8.0's check on the merge's parent; passing
`base` and `selections` lets path-filtered and called workflows reuse.

The receipt proves only what the run's own validation proved. Possession of
an archive is not trusted on its own: the run lookup, its conclusion and the
gateway's per-run write scope are what make it evidence. Lookups share a
100-second deadline, with 10-second API timeouts, a 4 MiB API document limit
and a 128 KiB receipt limit. When reuse unexpectedly stops, read `reason` in
the push run's acceptance step: `no pull request run validated <sha>` means the
merge was not a merge commit of a tested head, `older than the receipt
lifetime` means the pull request sat longer than `max-age-hours`, `did not pass
<jobs>` means the push needs jobs the pull request's scope skipped (its base
differed from the push's), `has no green run` means the scope's base did not pass
the workflow (re-run its trunk run, or wait for the next push), and an `acceptance
evidence unavailable` reason names the API or gateway error.

## Unchanged scheduled runs

`ashtonian/go-ci-actions/already-passed@FULL_COMMIT_SHA` tells a scheduled
workflow whether named jobs already passed on this commit, so a nightly can
skip a soak or a long suite that has nothing new to check while its other jobs
still run (model tests with new seeds, say).

It lists up to `lookback` (10) earlier completed runs of the running workflow
file for the same `event` (default the current one) and `branch` (default the
current ref), newest first, excluding the running run. The first run on
another commit ends the search with `passed=false`: the jobs have something new
to check. A run that skipped every named job is passed over. Otherwise the
newest run that ran them decides: `passed=true` only when every matching job
succeeded, so a failure on this commit runs them again the next time. A name
covers the job of that name, its matrix variants, `name (variant)`, and, for a
job that calls a reusable workflow, every job it calls, `name / job`. An API
error gives `passed=false` with a notice: missing evidence never skips work.
After `lookback` runs that all skipped the jobs, they run again, which bounds
how long an unchanged commit goes without them.

```yaml
jobs:
  history:
    runs-on: <runner>
    permissions: {actions: read}
    outputs:
      passed: ${{ steps.soak.outputs.passed }}
    steps:
      - id: soak
        if: github.event_name == 'schedule'
        uses: ashtonian/go-ci-actions/already-passed@FULL_COMMIT_SHA
        with:
          jobs: soak
  soak:
    needs: history
    if: ${{ !cancelled() && needs.history.outputs.passed != 'true' }}
    ...
```

Inputs: `jobs` (required, one per line), `event`, `branch`, `lookback` (1-50)
and `token` (`github.token`; needs `actions: read`). Outputs: `passed` and
`reason`, which the log repeats. It makes at most `lookback + 1` API calls,
each with a 10-second timeout.

## Ownership and validation

This repository owns toolchain/cache policy. Consumers own build/test commands.
Infrastructure owns runner admission, storage, limits and credentials.

Run npm test with Node 24+ and actionlint. CI validates the packaged action on
the in-cluster `arc-go-ci-actions` runners. Hosted macOS is opt-in through the
repository variable `MACOS_CI=on`; it is excluded by default. The contracts cover
successful cross-job save/restore, matrix isolation, failed-job
save suppression, restore-only and disabled modes, and the remote backend's
plugin environment (GOLANGCI_LINT_CACHEPROG included) and modules-only archive, a ready module proxy's GOPROXY and
build-only archive, and the fallback when the proxy does not answer. A real
job-container check uses Karsto's pinned Playwright runtime to verify remote
object reuse from fresh local directories, and that a module proxy the runner
bundle declares is the one in use. The remote contract also checks that the
module archive key hashes only the manifests under go-version-file's
directory, and the disabled contract that off mode has no key. Policy tests
cover reruns, invalid inputs, safe pruning, long-running jobs, backend
selection, manifest scoping and patterns, skipping the digest and the post-step
walk when nothing is archived, and the npm registry cache's selection,
precedence and health paths. The test-input-mtimes tests stamp real Git
checkouts: two checkouts of a commit get identical times, a same-size edit
changes only the edited file's time, a file changed after checkout is stamped
from its new content and Git still reports it, the refreshed index reads
clean, and untracked files, submodules, symbolic link targets, off mode,
workspaces without Git and work trees outside the workspace are left alone.
The test-results contract runs `go test` on a fixture that reads `testdata`:
the result recorded in one checkout replays as `(cached)` in a fresh checkout
of the same content, misses with checkout times, and re-executes and fails
after a same-size fixture edit. No npm dependencies. `test/acceptance_test.py`
(`python3 -m unittest discover -s test -p acceptance_test.py`) checks that a
receipt is recorded only for a same-repository pull request merge commit with
no failed or cancelled job, that it lists passed and skipped jobs apart, and
that verify reuses validation only for a matching receipt that passed every
required job, against a real Git merge fixture; the smoke job runs it. The
history tests cover already-passed's decision over earlier runs and the
packaged action against a stub API. The buildx-cache tests cover the tag per
ref and platform, the GitHub-cache fallback, input validation, and the
packaged action refusing a multi-platform cache on a two-node builder. The scope tests cover globs, Go package
patterns, configuration errors, each event's base, job selection, and the
packaged action over real shallow clones (a pull request merge whose base it
fetches, a push against a stubbed green run, every fallback to a full run, and
Go jobs narrowed to affected packages). The affected-package tests run real
`go list` over a three-module workspace: reverse dependencies across modules
and through external tests, testdata and embedded files, build tags, packages
that fail to load, and every case that affects every package. They need Go on
PATH, so the smoke job runs them after setup; outside Actions they skip without
Go.

The Action contract dogfoods both: its scope job selects smoke (code and
tests), verify (the cache contract jobs it aggregates) and npm-registry from
the changed paths, a change to ci.yml runs everything, and documentation-only
changes run nothing. Pull requests record a receipt; the merge push reuses it.
workflow_dispatch runs everything.

Release signed commits with immutable version tags, and note each release in
[CHANGELOG.md](CHANGELOG.md). Upgrade consumers through
reviewed SHA changes and roll back to the previous SHA. Measure cold, warm,
source-change, dependency-change and matrix behavior before cache policy
changes; do not infer a speedup from unrelated repositories.

The fresh job-isolated cache approach is described in
[CloudX's article](https://www.cloudx.ai/posts/setup-go).

## Workflow artifacts

The shared [SeaweedFS artifact actions](docs/artifacts.md) provide upload, download
and receipt-consumer tooling with native GitHub OIDC and per-run write scope.
