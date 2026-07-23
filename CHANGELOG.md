# Changelog

All notable changes to Groundtruth are recorded here. Dates are release dates; the
detailed symptom → root-cause → fix → regression-test log lives in `FIXES.md`.

## [2.1.0] — 2026-07-23

Three additive, backward-compatible honesty improvements over 2.0.0. No config change
needed; opt out of the whole contract engine with `GROUNDTRUTH_CONTRACT=0` as before.

### Added — multi-turn deferral persistence (spec §6)

A `deferred` claim declared on an earlier turn now stays visible on later turns' cards
until verified work closes it, reconstructed from the transcript (the unforgeable record)
rather than a forgeable ledger — so a declared set-aside can't silently vanish by being
omitted next turn. Closure uses only verify-grounded channels and a distinctive key.

### Added — prose class-1 fallback for contract-unaware turns (warn-only)

A session whose agent never emits a `groundtruth-claims` block now still gets a bare prose
"tests pass" lie caught (warn), reinstating v1's `_passClaim` shape (a test/build noun +
a pass-verdict verb, with negation/modal/reported-speech guards). Never fires when a valid
block exists, abstains with no transcript, and doesn't fire on honest closings like
"Done — fixed the typo."

### Changed — `no_change` contradiction is now block-eligible

A `no_change` claim may no longer coexist with any other claim (schema-invalid → NC), and
a sole `no_change` claim on a turn that authored non-excluded changes is now a block-tier
`CA` self-contradiction (naming up to 3 paths), with the redundant per-file `UC` warns
suppressed. An empty authored set or an all-excluded diff stays silent (the honest case).

### Added — tree-state stamping for `tests_pass`/`build_pass` staleness

The green-run staleness check previously relied on within-session event ordering (the
last green run's position vs the last source edit). Its blind spot, surfaced by
**community review**: an edit made through the **bash channel** (`sed -i`, a heredoc,
`> f`) never updates the edit position — it tracks only `Write`/`Edit` tool ops — so a
green predating such an edit passed clean.

This is closed by recording the repo's **code fingerprint** independently at command time
and comparing it at claim time — grounded in code state rather than event ordering, so it
sees a bash-channel edit directly:

- **Stamp** — a new `PostToolUse[Bash]` hook (`--stamp`) records `{ head, tree }` after
  every `TEST_BUILD_RE` command, appending one JSON line to
  `.claude/groundtruth/<session>-stamps.jsonl`. `tree` is a hash of the repo's **normalized
  code** — the `CODE_EXT_RE` source files (comments and whitespace stripped, the same scope
  and normalization the event-ordering anchor already treats as "staling"), read straight
  from disk. So it does **not** fire on a docs/config edit, a comment-only or whitespace-only
  edit, a harness-written settings file, or a commit of the tested code (the fingerprint is
  absolute content — HEAD identity is not compared); a real code change through any channel
  does. Groundtruth's own `.claude/groundtruth/` state is excluded. Non-mutating git only
  (`--no-optional-locks`); fail-open (not a repo / git error / non-matching command → writes
  nothing).
- **Sensor** — a `stale-by-tree` check runs ahead of the event-ordering check in the
  at-most-one-fires chain: when the stamp for the last matching green run differs in code
  fingerprint from the value computed now, it emits a warn-tier `CA` (*"the working tree has
  changed since that run — the green is STALE"*). Every uncertainty **abstains** (no stamps,
  malformed line, ambiguous stamp↔run mapping, failed current-tree computation), falling back
  to the unchanged event-ordering check — a false "stale" on an honest green is the fatal FP
  this must never emit. Because the stamp log is agent-writable on-disk state, the sensor can
  only **add** a stale warn; a `fresh` verdict never suppresses the transcript-anchored
  event-ordering warn.
- **Tamper surface** — the stamp log is in the referee-tamper perimeter: an agent-authored
  `Write`/`Edit` to it is flagged. A deleted or missing log is treated as absence (abstain),
  never as evidence.

Scope note: stamps are per-session (`<session>-stamps.jsonl`); a claim citing a command
with no matching run in *this* session is already intercepted by the "no such command ran
this session" check, so the sensor's reach is within a session (including a resumed one).

Design credit to **community review** for identifying the blind spot and the
record-at-command-time / compare-at-claim-time approach, and for the review pass that
rescoped the fingerprint from the whole tree to normalized code (avoiding a false-stale on
every honest post-green docs/comment/commit turn).
