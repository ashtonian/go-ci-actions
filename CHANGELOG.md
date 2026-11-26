# Changelog

Releases are signed tags on merge commits of `main`. Pin the full commit SHA
with the tag as a comment (`@<sha> # vX.Y.Z`).

## v1.13.1

- **artifact-consumer:** skips a pull request from a fork. The job runs on
  the runner the caller names, usually self-hosted, and the caller's event
  applies inside the called workflow, so the guard covers every caller. A
  required status check counts the skipped job as passed.
- **CI:** this repository's Action contract jobs also skip the owner's pull
  request when its head is on a fork.

## v1.13.0

- **acceptance (breaking):** verify no longer trusts the receipt's contents.
  Any job of a pull request run with `id-token: write` can write the run's
  receipt, so through v1.12.0 code under review could forge the passed jobs
  and selections and have the merge push skip a job that failed. Receipts are
  version 2 and name only the commit the run checked out. verify reads that
  commit from GitHub (`git/commits`) and accepts it only as GitHub's merge of
  the head into this push's parent, with the push's tree, committed no later
  than the run was created (a dispatched run: the head itself, with the
  push's tree, in a workflow whose `workflow_dispatch` declares no inputs).
  Which jobs passed comes from the run's jobs (`actions/runs/<id>/jobs`,
  latest attempt), mapped to job IDs through the workflow's job names,
  matrix suffixes and reusable-workflow calls; a name two jobs could show is
  evidence for neither. What the pull request checked comes from the new
  `parent-selections` input, which the push's scope computes. Without it, a
  job is reused only when `base` is the merge's parent. record's
  `selections` input is gone; receipts from older record steps are not
  reused. The verify token needs `contents: read`.
- **acceptance:** `max-age-hours` defaults to 168, the receipts' seven-day
  retention, and refuses more; validation does not go stale while its tree
  is unchanged, and the green-base rule still bounds what changed around it.
- **scope:** on a push of a merge commit, the new `parent-selections` and
  `parent-files` outputs measure the change from the merge's first parent, as
  the pull request's run measured it, over the same checkout and Go package
  graph (loaded once for both measurements).
- **already-passed:** decides each named job on its own. A run that ran some
  of the names no longer vouches for the rest; the new `passed-jobs` output
  lists the names that passed, so one call can gate several jobs.
- **CI:** this repository's workflows cancel superseded pull request runs
  only; every main push run finishes.

## v1.12.0

- **runner-labels (new):** fails a workflow that names a self-hosted runner
  label no runner of the repository carries, a job GitHub would leave queued
  until cancelled. It reads `runs-on` in every form, matrix values, and the
  `runner`/`*-runner` inputs of reusable workflow calls, and checks them
  against the labels the site's runner label service serves for the
  repository (`endpoint`, else `CI_RUNNER_LABELS_URL`, else `runnerLabelsURL`
  in the runner bundle, each HTTP(S) without credentials or a fragment, with
  no redirect followed) or against `labels-file`. Only a definitive list
  fails it, and a malformed `endpoint` input; an unreachable, failing or
  unconfigured service skips the check with a warning.

## v1.11.1

- **acceptance:** a `workflow_dispatch` run on a branch records a receipt for
  the branch head, and a push reuses it when the merge has the head's tree,
  under the same selection and green-base rules. A bot's pull request, whose
  own run cannot start under an owner-only actor policy, is validated that
  way. verify considers the latest pull_request or workflow_dispatch run for
  the merge's second parent; a pull request receipt must still be the merge.
  record stores the selections it is given, never "all" for the event, so a
  dispatch narrowed by its inputs records what it ran; a dispatched receipt
  is reused only against `selections`, and one with none covers nothing.

## v1.11.0

- **acceptance:** a push reuses a job only when the pull request checked at
  least what the push's scope selects for it. record stores each job's
  `selections` (the scope's output) in the receipt, and verify compares the
  push's `selections` with them: `"all"` covers anything, otherwise the
  push's set must be a subset. Without `selections`, verify ignores `base`
  and requires the merge's parent to be green, as in v1.8.0. This closes the
  gap in v1.10.0 below.
- **acceptance:** the deprecated `green_parent` output is gone; read
  `green_base`.
- **scope:** a `selections` output: each selected job's affected Go packages
  as import paths, or `"all"`.
- **scope:** per-job `go-binaries`: a job that tests built binaries runs only
  when a file in their non-test build closure (sources, embeds, manifests)
  changed, not for test-only changes.
- **scope:** a `!` glob excludes in a job's `paths`, in `shared` and in
  `go-ignore` (some-with-excludes); a list of only excludes fails.
- **scope:** `jobs-workflow` names the file defining the job IDs, for a
  reusable workflow whose caller's runs are the history.
- **scope, acceptance:** `path`, the checkout's directory under the
  workspace, for a repository checked out beside the siblings its go.mod
  replaces.
- **scope, acceptance:** only `push` and `schedule` runs make a base green;
  a green `workflow_dispatch` can be a narrowed run.
- **acceptance:** a job with no recorded selection (one that ran in a reduced
  mode the scope did not select) covers only an empty selection.

## v1.10.0 (do not pass `base`)

- **acceptance:** verify takes `base` and requires it, not the merge's
  parent, to have a green run; `green_base` output, `green_parent` kept as a
  deprecated copy.
- **Known unsound:** with `base` passed, a job narrowed to affected packages
  was reused against a base older than the parent without comparing what the
  pull request checked, so a red commit between them could go unchecked
  until the nightly. On v1.10.0, leave `base` out (verify then checks the
  parent as v1.8.0 did), or upgrade to v1.11.0.

## v1.9.0

- **setup:** content-derived file mtimes, so `go test` reuses results across
  checkouts; linters share the remote cache and the nightly fills it.
- **buildx-cache:** registry BuildKit caches scoped like GitHub's.

## v1.8.0

- **setup:** manifests are hashed only when an archive needs a key, scoped to
  go-version-file's module; the post step walks only archived directories.
- **scope** (new): which jobs and Go packages a change needs, measured from
  the pull request's base or the last green trunk run; `go-builds` ×
  `go-tags` graphs; `go-owners`; `go-args`.
- **acceptance** (new): the merge push reuses the pull request's receipt job
  by job (`remaining`) when the merge's parent has a green run
  (`green_parent`).
- **already-passed** (new): a scheduled run skips jobs that passed on its
  commit.
