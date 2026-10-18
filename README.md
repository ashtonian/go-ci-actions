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
seed-from-other-workloads (true), and max-staleness-hours (2).

Set cache-mode to read-only to restore without pruning or saving; off installs
Go without restoring or saving caches. Include matrix variants, build flags and
external C library versions in workload. Go does not detect changes to cgo system
libraries. Keep forced execution for integration, benchmark and other
environment-dependent checks in caller workflows.

Outputs: go-version, actual-toolchain, cache-primary-key, cache-matched-key,
cache-hit. A prefix restore provides reuse even when cache-hit is false.

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

The go-v1 namespace and workload digest preserve existing local-helper warm
caches. Empty manifest sets are supported for scaffold-generation jobs.
Cache paths must not contain credentials.

## Ownership and validation

This repository owns toolchain/cache policy. Consumers own build/test commands.
Infrastructure owns runner admission, storage, limits and credentials.

Run npm test with Node 24+ and actionlint. CI validates the packaged action on
Linux/macOS, successful cross-job save/restore, matrix isolation, failed-job
save suppression, restore-only and disabled modes. Policy tests cover reruns,
invalid inputs, safe pruning and long-running jobs. No npm dependencies.

Release signed commits with immutable version tags. Upgrade consumers through
reviewed SHA changes and roll back to the previous SHA. Measure cold, warm,
source-change, dependency-change and matrix behavior before cache policy
changes; do not infer a speedup from unrelated repositories.

The fresh job-isolated cache approach is described in
[CloudX's article](https://www.cloudx.ai/posts/setup-go).
