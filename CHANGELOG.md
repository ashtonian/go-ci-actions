# Changelog

Releases are signed tags on merge commits of `main`. Pin the full commit SHA
with the tag as a comment (`@<sha> # vX.Y.Z`).

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
- **scope:** a `!` glob excludes in a job's `paths`, in `shared` and in
  `go-ignore` (some-with-excludes); a list of only excludes fails.
- **scope:** `jobs-workflow` names the file defining the job IDs, for a
  reusable workflow whose caller's runs are the history.

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
