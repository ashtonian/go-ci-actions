# Shared action design

The first release consolidates duplicate cache policy into one commit-pinned
action. Generic source is public so public and private consumers need no extra
cross-repository credential. Site values and runner policies stay private.

Official actions own compiler installation and cache transport. Our code owns
compiler resolution, cache identities, input validation and working-set pruning.
It does not implement a cache service or choose consumer test commands.

Module/build paths remain in one archive for existing warm-cache compatibility.
Separating archives or adding a backend requires measured transfer, duplication
or eviction cost that warrants more restore/save operations. Compatible
cross-workload seeding can be disabled per consumer.

The lifecycle hook is declared after actions/cache, so reverse post ordering
prunes before upload. Its cutoff is relative to setup start, preserving objects
used early in long jobs. Failed/cancelled jobs do not publish state; read-only
mode does not prune or publish; off touches neither cache. Inputs are data to
Node, never interpolated shell commands.

Restore and save registration use separate official steps. The restore action
exposes the actual matched key for both cache modes. The combined cache action
registers a successful post-save with lookup-only and no fallback keys, avoiding
a second download. The read-write warm-cache contract also verifies the published
key output and the existence of its new saved entry.

Rollout: local policy/lifecycle tests, packaged Linux/macOS smoke and native
cache lifecycle probes, small consumer canaries, then remaining repositories.
Consumers pin only an exact action commit that passed. Existing commands,
security gates and unrelated failures remain visible.
