# SeaweedFS workflow artifacts

## Overview

`upload-artifact`, `download-artifact` and `artifact-setup` store CI artifacts in
SeaweedFS through its native GitHub OIDC bearer authentication. They do not use
GitHub's artifact quota or put long-lived storage keys in a runner. ZIP payloads
are immutable and content addressed; a manifest publishes a named artifact only
after its payload upload completes. Downloads verify size and SHA-256 first.

## Configuration

| Input/environment | Default | Meaning |
|---|---|---|
| `endpoint` / `CI_ARTIFACT_ENDPOINT` | required | HTTPS gateway origin; HTTP is permitted only for a `.svc.cluster.local` service |
| `bucket` / `CI_ARTIFACT_BUCKET` | `ci-artifacts` | Dedicated artifact bucket |
| `name` | upload: `artifact`; download: all | Unique name within a run attempt; download selects an exact name |
| upload `path` | required | File, directory, or newline-separated globs; `!` excludes matches |
| download `path` | `.` | Destination directory |
| `if-no-files-found` | `warn` | `warn`, `error`, or `ignore` |
| `retention-days` | `0` | Integer 1–90; zero uses `GITHUB_RETENTION_DAYS`, capped at 90 (90 if unset) |
| `compression-level` | `6` | ZIP compression level 0–9 |
| `overwrite` | `false` | Replace a named manifest in this attempt only |
| `include-hidden-files` | `false` | Include hidden files after inspecting their contents |
| download `pattern` | none | Glob over artifact names |
| `merge-multiple` | `false` | Extract multiple archives together instead of name subdirectories |
| `run-id` | current run | Source run within the same repository |
| `run-attempt` | all | Highest attempt to consider; latest artifact per name wins |
| `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` | runner supplied | Numeric identity; must match the signed token |
| `GITHUB_REPOSITORY`, `GITHUB_SHA` | runner supplied | Provenance recorded with the manifest |
| `CI_ARTIFACT_TOOL` | exported by setup | Canonical Python CLI path for custom consumers |

## Dependencies

Python 3.11+ and the runner's Node 24 action runtime; no installed Python or npm
packages. The gateway needs SeaweedFS's OIDC/IAM support, a dedicated bucket,
claim-scoped policies and the retention paths described below. GitHub jobs need
`permissions: {contents: read, id-token: write}`. Reusable workflow callers must
grant that permission as well. Fork execution remains subject to repository
admission policy; this action does not grant approval or expand repository trust.

## Interfaces

Pin all actions to a reviewed full commit SHA. Configure the repository variable
`CI_ARTIFACT_ENDPOINT`, then supply it at workflow level:

```yaml
permissions:
  contents: read
  id-token: write
env:
  CI_ARTIFACT_ENDPOINT: ${{ vars.CI_ARTIFACT_ENDPOINT }}
# In producer steps:
# - uses: ashtonian/go-ci-actions/upload-artifact@<reviewed-commit>
#   with:
#     name: test-results
#     path: reports/
#     retention-days: 7
# In a job that needs the producer:
# - uses: ashtonian/go-ci-actions/download-artifact@<same-commit>
#   with:
#     name: test-results
#     path: restored/
```

Upload outputs are `artifact-id` (manifest key), `artifact-digest` (SHA-256), and
`artifact-url` (S3 URI). These are **not GitHub artifact IDs or browser download
links**. The job summary records the URI, size, digest and retention. Download
exports `download-path`. Release assets and GitHub Pages deployment artifacts
have separate contracts and are not replaced by these actions.

After `artifact-setup`, receipt consumers can use:

```sh
python3 "$CI_ARTIFACT_TOOL" list --run-id "$SOURCE_RUN_ID"
python3 "$CI_ARTIFACT_TOOL" download --run-id "$SOURCE_RUN_ID" \
  --name acceptance --path receipt.zip --archive --max-bytes 131072
```

`list` returns verified manifest identities. Consumers still verify the producing
workflow, source/tree, run attempt and job conclusions through GitHub; possession
of an archive does not prove a passing check. Existing historical GitHub receipts
may use a read-only fallback until their original expiry. New writes have one
backend. `gh run download` does not retrieve SeaweedFS artifacts. Outside Actions,
operators use the deployment's authenticated S3 access and the summary's object
URI; the workflow token itself is short lived and is never published.

## Build, run and test

`python3 -m unittest discover -s test -p artifact_test.py` checks path layout,
hidden/excluded files, manifest identity, checksum rejection, safe extraction and
rerun selection. The `SeaweedFS artifact contract` workflow verifies two-job byte
round trips against the actual gateway and denies cross-repository/run, root-list
and anonymous requests. Native acceptance is required before consumer rollout.

Consumers can call `.github/workflows/artifact-consumer.yml` with their runner
label to check repository OIDC, endpoint configuration and an exact byte/layout
round trip without running application suites. Trigger it when artifact workflow
configuration changes; the shared native contract owns the full isolation tests.

## Operations

Data keys are `data/<days>d/<repository-id>/<run-id>/<attempt>/<name-hash>/<sha>.zip`;
manifests are `metadata/<repository-id>/<run-id>/<attempt>/<name-hash>.json`.
Configure native filer TTLs on each `data/<1..90>d/` prefix and a 90-day TTL on
`metadata/`. The manifest's expiry suppresses stale reads immediately; the volume
server reclaims expired TTL volumes. Changing retention later cannot extend
already-written objects. Aborted uploads or replaced manifests leave payloads
that expire under their original TTL. Data here is disposable CI evidence, not a
backup or permanent release store.

Gateway requests use 120-second socket deadlines and the GitHub OIDC token
request a 30-second one. Each gateway request, including the token request in
front of it, gets at most six attempts for transient errors (429, 500, 502,
503, 504, timeouts and connection failures), waiting 1, 2, 4, 8 and 16 s
between them, or the server's `Retry-After` when that is longer, up to 30 s.
GitHub's token service answers 503 for many seconds at a time; `@actions/core`
retries it ten times. Each retried failure logs a line naming the request
(`artifact: GitHub OIDC token request failed (HTTP 503); attempt 1 of 6,
retrying in 1 s`), and a final failure names the host that answered, so a
token-service outage reads differently from a gateway one. The action
subprocess has a 15-minute deadline.
Transfers/extraction are capped at 50 GiB; document reads at 16 MiB and listings at
10,000 manifests. A missing named artifact fails; an empty pattern/all listing
succeeds with no files, matching aggregation of optional producers.

A 403 indicates identity, policy, audience or endpoint configuration; do not
retry it blindly. A 412 means a name collision unless the same immutable upload
is being retried. Missing/expired evidence causes dependent checks to run, never
to accept unproven results. SHA mismatch is fatal. A failed gateway fails artifact
publication; there is no silent GitHub-storage fallback. Monitor gateway errors,
object capacity, expiry, and the native contract workflow.

## Security

The gateway verifies issuer, signature, audience, expiry and owner policy. Reads
are limited to the signed repository ID; writes to its signed run and attempt.
No bearer credential follows redirects. The client checks matching local identity
for configuration mistakes, but authorization belongs to the server. Do not use
an endpoint controlled by an untrusted workflow contributor. Existing runner
admission remains mandatory.

Extraction rejects absolute/traversal paths, Windows drive/backslash paths,
archive symlinks and existing destination symlinks escaping the output directory.
Uploads omit symlink files and reject paths escaping their search root. ZIP
layout preserves the least common search root. Directory metadata and executable
permissions are not an artifact contract; archive a tarball when those matter.

## Code map

- `lib/artifact.py`: shared transport, manifests, archive rules and CLI.
- `lib/artifact-entry.cjs`: bounded Python launch for Node actions.
- `upload-artifact/`, `download-artifact/`, `artifact-setup/`: action interfaces.
- `test/artifact_test.py`, `test/artifact-native.py`: contract and native checks.
- `.github/workflows/artifacts.yml`: real gateway acceptance.

## Docker build records

Set `DOCKER_BUILD_RECORD_UPLOAD: "false"` in workflows using
`docker/build-push-action` to stop its implicit GitHub artifact upload. After each
build step, call `build-record` with `metadata: ${{ steps.build.outputs.metadata }}`
and `if: always() && (steps.build.outcome == 'success' || steps.build.outcome == 'failure')`.
It exports that exact reference with Buildx, then uploads through the same artifact
client. Image publication, attestations, build caches and Docker job summaries are
unchanged. Use the shared `download-artifact` action to retrieve the `.dockerbuild`
file for import into Docker Desktop.

The action requires Python 3.11+, Docker Buildx with `history export`, and the same
OIDC/endpoint configuration as uploads. Inputs are `metadata` (required for an
export), `name` (prefix, default `build-record`), `retention-days` (default 7), and
`endpoint` (defaults to `CI_ARTIFACT_ENDPOINT`). The Buildx record ID is appended to
the prefix so matrix jobs and multiple builds cannot overwrite one another. Export
has a 120-second deadline. A build with no metadata warns and leaves its diagnostics
in the original job log; it never substitutes another build's record. An export or
storage failure fails the preservation step. The Docker record contract builds a
minimal real image and compares the exported record with its downloaded bytes.
