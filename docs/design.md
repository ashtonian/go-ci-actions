# Shared action design

The first release consolidates duplicate cache policy into one commit-pinned
action. Generic source is public so public and private consumers need no extra
cross-repository credential. Site values and runner policies stay private.

Official actions own compiler installation and cache transport. Our code owns
compiler resolution, cache identities, input validation and working-set pruning.
It does not implement a cache service or choose consumer test commands.

With the GitHub backend, module/build paths remain in one archive for existing
warm-cache compatibility. Compatible cross-workload seeding can be disabled
per consumer.

The remote backend exists because of measured eviction, as this document
requires for a new backend. On 2026-10-21 the three largest consumers each
held about 10 GiB, GitHub's per-repository limit. In one, BuildKit layer
blobs (7.8 GiB) had evicted every Go entry. The other two kept one to two
days of 390-550 MiB archives, which every job downloaded whole and every
successful job saved again. A runner that provides a GOCACHEPROG plugin
serves build objects per action instead: a job fetches only what it
compiles, and nothing per job is archived. The runner, not this action, owns
the plugin, its endpoint and the write authorization; the action only
detects them and exports the plugin variables. Modules stay in the GitHub
cache, saved once per workload and manifest set.

The module proxy mode exists because the remote backend's module archives
became the eviction. On 2026-11-09 Karsto's cache held 13.6 GB against the
10 GB limit, 11.3 GB of it in eleven per-workload module archives of about
1 GB, each restored whole by every Go job in 17-35 seconds. Archive sharing
cannot be fixed in keys alone (#6): a partial first writer seeds every later
job, and container and host archives extract to different roots. Modules are
immutable and content-addressed, which is what a module proxy serves: a job
fetches only the modules it uses, from the runner's network, and nothing is
archived. The runner owns the proxy, its upstream and its trust; the action
only detects it, checks that it answers, and puts it in front of the job's own
GOPROXY so that any failure falls through.

The npm registry action applies the same contract to pnpm and npm. Lockfiles
pin package integrity, not the registry, so a pull-through registry changes
only where tarballs come from. The runner owns the registry and publishes its
URL; the action checks `/-/ping`, and exports the registry variables only when
the cache answers and the job sets no registry of its own. A cache outage
leaves installs on the registry the job configures.

Container jobs discover a versioned runner-owned bundle through their tool-cache
mount. It contains the executable and endpoints, which otherwise remain outside
the container's filesystem/environment. Discovery does not install software,
copy credentials or change cache authorization. A missing helper retains the
existing archive fallback; invalid published configuration fails explicitly.

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
