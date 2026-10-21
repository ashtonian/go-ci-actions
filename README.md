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
seed-from-other-workloads (true), max-staleness-hours (2), and
build-cache-backend (auto).

Set cache-mode to read-only to restore without pruning or saving; off installs
Go without restoring or saving caches. Include matrix variants, build flags and
external C library versions in workload. Go does not detect changes to cgo system
libraries. Keep forced execution for integration, benchmark and other
environment-dependent checks in caller workflows.

Outputs: go-version, actual-toolchain, build-cache-backend (github, remote or
off), cache-primary-key, cache-matched-key, cache-hit. A prefix restore
provides reuse even when cache-hit is false.

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

The go-v1 namespace and workload digest preserve existing local-helper warm
caches. Empty manifest sets are supported for scaffold-generation jobs.
Cache paths must not contain credentials.

## Ownership and validation

This repository owns toolchain/cache policy. Consumers own build/test commands.
Infrastructure owns runner admission, storage, limits and credentials.

Run npm test with Node 24+ and actionlint. CI validates the packaged action on
Linux/macOS, successful cross-job save/restore, matrix isolation, failed-job
save suppression, restore-only and disabled modes, and the remote backend's
plugin environment and modules-only archive. Policy tests cover reruns,
invalid inputs, safe pruning, long-running jobs and backend selection. No npm
dependencies.

Release signed commits with immutable version tags. Upgrade consumers through
reviewed SHA changes and roll back to the previous SHA. Measure cold, warm,
source-change, dependency-change and matrix behavior before cache policy
changes; do not infer a speedup from unrelated repositories.

The fresh job-isolated cache approach is described in
[CloudX's article](https://www.cloudx.ai/posts/setup-go).
