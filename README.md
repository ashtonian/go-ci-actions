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
(false), workload (empty), cache-dependency-path (all go.mod/go.sum/go.work/
go.work.sum files), cache-mode (read-write), cache-key-prefix (go-v1),
seed-from-other-workloads (true), max-staleness-hours (2),
build-cache-backend (auto) and module-proxy (auto).

Set cache-mode to read-only to restore without pruning or saving; off installs
Go without restoring or saving caches. Include matrix variants, build flags and
external C library versions in workload. Go does not detect changes to cgo system
libraries. Keep forced execution for integration, benchmark and other
environment-dependent checks in caller workflows.

Outputs: go-version, actual-toolchain, build-cache-backend (github, remote or
off), module-proxy (the runner proxy in use, or empty), cache-primary-key
(empty when nothing is archived), cache-matched-key, cache-hit. A prefix
restore provides reuse even when cache-hit is false.

## Policy

Keys include runner OS/architecture, resolved GOVERSION, a digest of
workflow/job/workload, manifests, run ID and run attempt. Successful jobs save
fresh state. Restore order is same workload/manifests, same workload with older
manifests, then a compatible compiler seed when enabled. GitHub enforces branch
and repository cache scope; sharing action code does not share cached contents.

Before successful post-save, build objects unused since setup began are pruned
with two hours of slack for Go's mtime-touch granularity. Long jobs retain
objects used early. Module source is not age-trimmed. Logs and job summaries
report restored/missed state, module/build bytes, trimmed bytes and maintenance
time. Official cache logs report transfer timing.

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

Job containers can consume the same runner-owned setup through the mounted
tool cache. Before accepting a job, the runner places a native executable at
`$RUNNER_TOOL_CACHE/go-ci-cache/v1/gocacheprog` and writes `config.json` beside
it with
`{"version":1,"remoteURL":"https://cache.example","moduleProxyURL":"http://proxy.example:3000"}`;
both endpoints are optional (see Module proxy). Use a real copy of the
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
directory is per job and is not trimmed or archived; max-staleness-hours
applies to the GitHub backend only.

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

## Ownership and validation

This repository owns toolchain/cache policy. Consumers own build/test commands.
Infrastructure owns runner admission, storage, limits and credentials.

Run npm test with Node 24+ and actionlint. CI validates the packaged action on
the in-cluster `arc-go-ci-actions` runners. Hosted macOS is opt-in through the
repository variable `MACOS_CI=on`; it is excluded by default. The contracts cover
successful cross-job save/restore, matrix isolation, failed-job
save suppression, restore-only and disabled modes, and the remote backend's
plugin environment and modules-only archive, a ready module proxy's GOPROXY and
build-only archive, and the fallback when the proxy does not answer. A real
job-container check uses Karsto's pinned Playwright runtime to verify remote
object reuse from fresh local directories, and that a module proxy the runner
bundle declares is the one in use. Policy tests cover reruns,
invalid inputs, safe pruning, long-running jobs and backend selection. No npm
dependencies.

Release signed commits with immutable version tags. Upgrade consumers through
reviewed SHA changes and roll back to the previous SHA. Measure cold, warm,
source-change, dependency-change and matrix behavior before cache policy
changes; do not infer a speedup from unrelated repositories.

The fresh job-isolated cache approach is described in
[CloudX's article](https://www.cloudx.ai/posts/setup-go).

## Workflow artifacts

The shared [SeaweedFS artifact actions](docs/artifacts.md) provide upload, download
and receipt-consumer tooling with native GitHub OIDC and per-run write scope.
