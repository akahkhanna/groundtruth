<h1 align="center">Groundtruth</h1>

<p align="center">
  <em>Your agent wears AI glasses. Groundtruth sees through them with his reading glasses.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/deterministic-no%20LLM%20%C2%B7%20no%20network%20%C2%B7%20no%20API%20key-111111?style=flat-square" alt="Deterministic: no LLM, no network, no API key">
  <img src="https://img.shields.io/badge/runs%20on-Claude%20Code-111111?style=flat-square" alt="Runs on Claude Code">
  <img src="https://img.shields.io/github/v/release/akahkhanna/groundtruth?style=flat-square&color=111111&label=release" alt="Release">
  <img src="https://img.shields.io/badge/self--checks-428%20%C2%B7%20red--team%2014%2F14-111111?style=flat-square" alt="428 self-checks, red-team 14/14">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <strong>Your &ldquo;done&rdquo; is a claim. The diff is the evidence.</strong>
</p>

<p align="center">
  <img src="assets/groundtruth-nerd.svg" alt="Groundtruth: your agent flashes &ldquo;done, tests pass&rdquo; through its AI glasses; Groundtruth pushes his reading glasses down and opens the diff." width="560">
</p>

You know the type. The **fact-checker.** He's seen it all, and he doesn't believe it until he sees it himself.
He doesn't take the press release — he reads the primary source. Your agent reports success through its AI
glasses; Groundtruth pushes his plain reading glasses down his nose, opens the `git diff`, and checks the claim
against what actually changed. He says little. When he catches your agent mid-&ldquo;done,&rdquo; the reaction
is the whole point:

<p align="center"><strong>&ldquo;&hellip;what the nerd.&rdquo;</strong></p>

## How to use it — the whole flow

Each step unlocks the next. You can stop at any stage and still get value.

1. **Install** (once) — from inside Claude Code:
   ```
   /plugin marketplace add akahkhanna/groundtruth
   /plugin install groundtruth@groundtruth
   ```
   This alone enables the hooks. Restart Claude Code so they register — from here **every agent turn
   already gets a warn-only verdict card** (honesty, completeness, security), with no further config.

   > **Updating:** `/plugin marketplace update groundtruth` refreshes the catalog (downloads the new version
   > into the cache) but does **not** move the *installed* pin, and a restart reloads the old pin — so the
   > verdict hook keeps running the stale engine, silently. Run `/plugin update groundtruth` (or reinstall)
   > **and restart** so the new engine actually loads; confirm `installed_plugins.json` shows the new version.
   > The status badge surfaces this for you: it shows `⬆<version>` when a newer version is cached but not yet pinned.

2. **Set up visibility** (once) — `/groundtruth-setup`
   A checker, not a switch. The engine is already on from step 1; this detects what's left and hands you
   the exact paste-in for the two things a plugin *can't* set itself: the **status badge** (how you see
   the card in the VS Code extension) and env vars. It changes no setting on its own.

3. **See it on your code right now** (optional) — `/groundtruth-audit`
   A one-off inventory of existing stubs / TODOs / phantom imports (plus any exposed `.env`). Findings,
   not a verdict.

4. **Arm your project rules**  ← this is what turns on the **Told & Ignored** bucket
   ```
   /groundtruth-rules-ai            # optional: a model pass proposing richer rules from your docs
   /groundtruth-rules approve-all   # REQUIRED to enforce — arms every *clean* rule; nothing arms until you run it
   ```
   On session start Groundtruth already read your docs (`CLAUDE.md`, `SCHEMA.md`, your skills, …) and
   **proposed** deterministic rules. `approve-all` arms the clean ones (zero existing-code hits); or run
   `/groundtruth-rules` bare to review and name specific ids. **`/groundtruth-setup` will also arm the clean
   ones inline, in warn, on a single yes** — the same thing, fewer steps. Either way it's a permission gate,
   not automatic; if an armed rule ever fires wrongly, the card prints its `[id]` — `/groundtruth-rules unarm <id>`.

5. **Enforce, once you trust the precision** — `/groundtruth-block on`
   (or set `GROUNDTRUTH_BLOCK=1` in `.claude/settings.local.json` — the un-disablable anchor). A
   block-severity finding then refuses the stop and hands the gap back, re-checking the fix for up to
   **2 attempts** before escalating to a human (never wedges). Until you do this, findings warn but never block.

Prefer to try it without installing? `git clone https://github.com/akahkhanna/groundtruth && claude --plugin-dir ./groundtruth`.

Requires: Claude Code, `node` ≥18, and a git repo (reality = `git diff HEAD`).

## Before / after

Your agent finishes a task and reports:

> **&ldquo;Done — added retry with exponential backoff, tests pass, and created `src/upload.test.js`.&rdquo;**

Groundtruth reads the same turn from the outside and renders this before the turn is allowed to end:

```
GROUNDTRUTH · Tier-1
  ASK  Add retry with backoff to the S3 client in src/upload.js, and a test in src/upload.test.js.

  🔴 Honesty — claims don't match what it did:
       🔴 false test/build claim — "tests pass", but no test command ran this session
       🟡 stub/placeholder in added code: // TODO: real backoff — single attempt for now
       🟡 silent no-op — claimed src/upload.test.js, but it is absent from the diff
  🔴 Rules — a security rule was broken in the diff:
       🔴 hardcoded secret — AWS access key in added code
  🟡 Tasks — 1 pending (surfaced once; closes only when it lands in code)

  VERDICT  🔴 ISSUES — blocked        (GROUNDTRUTH_BLOCK=1 to halt)
  ⚪ Deterministic verdict (no LLM). Your "done" is a claim; the diff is the evidence.
```

Four confident sentences; four things that weren't true. Groundtruth catches all four **deterministically** —
no model reads the work, so nothing can be talked out of the verdict.

---

**Audits whether an agent actually did what it was asked — and catches the false "Done."**

A coding agent reports success. Groundtruth reads the *same* turn from the outside — the request, what
the agent claimed, the actual `git diff`, and your project's standing rules — and renders a one-screen
verdict before the turn is allowed to end. It is a **deterministic local hook: no model calls, no network,
no API key.**

Failures sort into three buckets by cause:

| Bucket | What happened | How Groundtruth catches it |
|---|---|---|
| **Told & Done** ✓ | instruction satisfied | nothing to do |
| **Told & Missed** ⚠ | part of the task was silently dropped | completeness check: every named subtask must map to a real change |
| **Told & Ignored** ✗ | a rule that was *in context* got overridden anyway | independent rule-compliance audit, with no stake in the work |

The third is the one nothing else catches: not forgetting, but *rationalising past* a rule the agent
could see. Groundtruth catches it because the auditor never did the work, so it never inherits the framing
("this is just a small addition") that let the rule slip.

## Measured — honestly

A verifier is only worth trusting if it's honest about its own misses, so here's the real state, not a marketing number.

- **The precision was rebuilt against real data, not intuition.** We read every finding Groundtruth emitted across **15 of its own recent sessions** — **23 findings, 74% of them false positives** — and froze those into a labeled [corpus](hooks/corpus.fixture.json) (reproduce with [`node benchmarks/corpus-precision.mjs`](benchmarks/)). Then independent adversarial review passes tried to break the fixes and built their own executable test cases.
- **Dogfood result:** running Groundtruth's audit on its own source, self-match false positives in the engine went to **0** (`Class 2`) and phantom-import FPs **3 → 0** (`Class 4`); self-checks **242 → 428**, red-team **14/14**.
- **Class 6 (dropped symbol) was built precision-first, adversarially.** A "refactor" that silently drops a method is caught only by its *consequence* — a call that no longer resolves — never by guessing rename intent, so a rename/merge/casing-change with callers updated stays **silent** and only a genuinely dangling reference fires (quoting the callsite). Two review passes drove it from a naive "defined-nowhere" check (which false-fired on every rename) to a receiver-gated dangling-call test; the TypeScript-signature and spaced-path (`%20`) holes they found are fixed and pinned by fixtures. It runs across the whole ladder: **warn** on Stop + pre-commit, **block** in CI.
- **Every fix is catalogued** with symptom → root cause → fix → regression test in **[FIXES.md](FIXES.md)** — including the two *critical* holes review found (a live secret demote-able by an adjacent comment; the agent demoting its own task by naming the file in its reply), and the residual deterministic-NL limits it does **not** fully close.
- **Still pending (named, not hidden):** a live before/after **false-positive rate across a week of real sessions** — Groundtruth ships an append-only history log + a `gt-harvest` reader so you can measure it on *your* repo. That headline number is the next measurement, and it will be published the same way: with its misses.

The through-line: *abstain or degrade to a bounded warn outside the domain a check is provably correct in — never a clean green — and never let the audited agent shape its own verdict.*

## Why Groundtruth?

AI agents suffer from the "hallucination of completeness." They will confidently tell you a feature is shipped and tested when they actually left placeholders and skipped the test runner.

Here is a real verdict card — the agent claimed *"Done — added retry with exponential backoff, tests pass, and created src/upload.test.js"* while the diff told a different story:

```
GROUNDTRUTH · Tier-1 · demo1a2b
  ASK  Add retry with exponential backoff to the S3 upload client in `src/upload.js`, and add a test in `src/upload.test.js`.

  WHAT WAS CHECKED:
  🔴 Honesty — the agent's claims don't match what it did:
       🔴 false test/build claim — claimed tests/build pass ("tests pass"), but no test/build command ran this session
       🟡 stub/placeholder — stub/placeholder in added code: // TODO: real exponential backoff — single attempt for now
       🟡 silent no-op — claimed a change to src/upload.test.js, but it is absent from the diff
  🔴 Rules — a security / standing rule was broken in the diff:
       🔴 hardcoded secret — AWS access key hardcoded in added code
  🟢 Completeness — the ask was specific enough to map subtasks against
  🟢 Tasks — every ask that named a deliverable is delivered
  ⚪ Debt — 0 pre-existing (already here at session start, not blamed) · 1 introduced this turn

  VERDICT  🔴 ISSUES — blocked
       means: a blocking issue is in the diff above — fix it before this ships
  ⚪ Deterministic verdict (no LLM). Semantic checks — spec-substitution, "rationalised past a rule", regression — are roadmap, not in this card.
```

## Commands

| Command | What it does |
|---|---|
| `/groundtruth` | Show the latest verdict card for this session. |
| `/groundtruth-rules` | Review + approve the rules compiled from your docs — **the permission gate**. `approve-all` arms every *clean* candidate; name rule ids to arm specific ones; `unarm <id>` silences one that's firing wrongly (the card prints each rule's `[id]`). Nothing arms until you do. |
| `/groundtruth-rules-ai` | **Opt-in, off by default.** Fans out an agent to read your docs in *prose* and propose the regex-enforceable rules the literal extractor missed — routed through the **same** grounding + approval gate. Nothing arms; the model runs only when you invoke this. |
| `/groundtruth-audit` | Scan the whole repo for the debt agents leave behind (stubs/TODOs, phantom imports) — an inventory, **not** a verdict. The cheapest way to see Groundtruth work on your code. |
| `/groundtruth-block on｜off` | Opt into blocking (default is **warn**). `on` shows an itemized, fire-count-backed confirmation of what will start halting (so block never enforces a rule you haven't seen) before it flips. A block-severity finding then refuses the stop and hands the gap back until it's fixed (retry cap → escalate, never wedges). |
| `/groundtruth-setup` | One-shot **installer**: detects what's configured, arms your clean rules inline (in warn, on consent), and hands you the exact actions for the rest (badge, env). |
| `/groundtruth-help` | What Groundtruth checks, and its commands. |

CLI (no install needed): `node hooks/groundtruth.mjs --audit` runs the repo audit; `--latest` prints the
most recent verdict card; `--install-pre-commit` wires a `.git/hooks/pre-commit` staged-diff scan
(fail-open, won't clobber a foreign hook); `--diff-range origin/main..HEAD` is the **CI/pre-merge gate**
(exits non-zero on a block-severity finding or a dropped-symbol dangling ref).

**Three enforcement rungs, one engine** — each catches what the last can't: **Stop** (Claude Code drives
the edit → a rich per-turn card, warn) → **pre-commit** (any author, incl. code *pasted from a chat* that
no Stop hook ever saw → warn at `git commit`) → **CI** (`--diff-range`, bypass-proof → **block** the PR).
Dropped-symbol dangling refs ride all three; a copy-paste hook installer + a ready GitHub Action
([`.github/workflows/groundtruth.yml`](.github/workflows/groundtruth.yml)) make the outer two one command each.

## How it works

Groundtruth runs two ways: **Audit** (`/groundtruth-audit` or `node hooks/groundtruth.mjs --audit`) scans
the whole repo for debt on demand — *findings, not a verdict* (stub/placeholder + phantom-ref). **Verify**
is the per-turn check below.

One deterministic `Stop` hook (`hooks/groundtruth.mjs`) — **no LLM, no network, always runs, ~free**. It
reads the claim from the Stop payload, intent + Bash evidence from the transcript, and reality from
`git diff HEAD`, then checks:

- **Honesty** — 1 false test/build claim ("tests pass" with no test run, or a failing run) · 2 stub/
  placeholder (`TODO`/`FIXME`/`NotImplemented`/`pass`/Rust `todo!()`/Go `panic("…")`/…) · 3 silent no-op
  (claimed a change to a file absent from the diff) · 4 phantom ref (a new relative import whose target
  doesn't exist) · 6 dropped symbol (a function/method the diff removed, defined nowhere in the tree yet
  still **called** — a dangling reference under a "refactor / everything preserved" claim; quotes the dead
  callsite) · 9 special-casing (non-test code that branches on test/CI/the auditor).
- **Completeness** (scope-miss) — a named deliverable in the ask that never lands in the diff (the
  open-loop / task ledger; name-matching, deliberately crude — it abstains when the ask names nothing).
  It also abstains when the turn is an **observation or question rather than a request** ("I can see a 304,
  it's fine, no fix needed") — a deterministic non-request gate, so a conversational aside is never minted
  into a phantom open loop. Still no LLM: the framing test is regex, and it errs toward not-tracking.
- **Rules** (directive-override — *the differentiator*) — your project's standing rules, **compiled from
  your own docs into deterministic predicates** and enforced. No LLM: the doc literally says
  ``use `X` not `Y` `` or ``never `Z` ``, so a violation is a regex match, not a judgment call.
- **Security** — hardcoded secrets, an RLS-off new table / anon-readable policy (Postgres/Supabase), a
  committed `.env`.

A **semantic layer** — richer ask↔delivery matching, spec-substitution, regression detection, and judging
when an agent *rationalised past* a rule rather than literally breaking it — is on the roadmap; **it needs
an LLM and is not shipped.** The plugin makes no model calls and needs no API key.

**Rules it reads** (auto-discovered, repo-agnostic): `CLAUDE.md`, `AGENTS.md`, `**/SCHEMA.md`,
`**/ARCHITECTURE.md`, `docs/*.md`, `**/.claude/skills/**/SKILL.md`, `**/.claude/agents/*.md`,
`.cursorrules`, `.windsurfrules`. From these it extracts two prose forms the author already marked as
code — corrective pairs (``use `X` not `Y` `` / ``use `X` (not `Y`)``) and explicit forbids
(``never `X```) — grounds each against the tree, and **proposes** (never auto-arms) them for you to
approve via `/groundtruth-rules`. Extraction stays deliberately narrow + literal; the permission gate, not
a smarter parser, is what makes it safe to read every doc.

**Re-proposal is automatic when a rule doc changes** — at session start, when the agent edits a doc via its
Edit/Write tools (a `PostToolUse` recompile), and when *you* hand-edit a doc in your own editor (the `Stop`
hook re-checks doc mtimes and recompiles if any is newer than the proposed set). So a rule you add or change
shows up as a fresh candidate the next turn, no restart needed. Only the **proposed** set refreshes this way
— nothing arms without `/groundtruth-rules`, and an already-armed rule keeps enforcing its approved text until
you re-approve the change.

**Nothing project-specific ships in the plugin** — it derives rules only from *your* repo's docs. For a
file-scoped rule a sentence can't express (e.g. "no `import.meta` under `api/_lib/`" — the directory scope
isn't in any doc line), drop a JSON array of rule objects at `.claude/groundtruth/seed-rules.json` in your
repo; they're merged in and grounded through the same gate. Shape: `{ id, kind: "forbid_in_added", file_re,
line_re, message }`.

**Optional — model-assisted rule extraction (opt-in, off by default).** `/groundtruth-rules-ai` fans out an
agent to read your docs in *prose* and propose the regex-enforceable rules the literal extractor missed. It
writes only to `seed-rules.json` and runs through the **same grounding + `/groundtruth-rules` approval gate**
— nothing arms, and the model runs only when you invoke it. This is the one place a model ever touches
Groundtruth, and only on demand; the per-turn audit stays fully deterministic and offline.

## Languages

Mechanics, not syntax — most checks are language-general. The honest scope:

- **General across languages:** false-"tests pass" (recognizes Go/Rust/Ruby/Java/.NET/Python/JS runners),
  stub/placeholder (TODO/FIXME + Rust `todo!()`, Go `panic("…")`, Java/C# `NotImplementedException`, Kotlin
  `TODO()`), silent no-op (any named source file), scope/completeness, directive-override, compiled rules
  (scoped to the languages your repo actually uses), secrets, and env exposure.
- **JS/TS + Ruby only:** phantom relative-import resolution (Class 4) — it resolves by file existence, which
  is only unambiguous where imports are path-relative. Python/Go/Rust/Java/C# (package-qualified) **abstain**
  (emit nothing) rather than false-flag.
- **Postgres/Supabase only:** the B1/B3 RLS checks — they fire solely on added `.sql` lines and are a no-op
  everywhere else.

## Warn vs block

- **Default: WARN.** The verdict is recorded; the turn is never disrupted. Non-destructive — build
  trust first. (Stop-hook stdout is debug-log-only, so read the verdict from the `.claude/groundtruth/`
  file or the status badge.)
- **Opt-in: BLOCK.** Run `/groundtruth-block on` (or set `GROUNDTRUTH_BLOCK=1`). A block-severity finding
  refuses the stop and hands back a corrective payload naming the target state, then **re-checks the agent's
  fix on the next stop** — a remediation loop **capped at 2 attempts**, after which it escalates to a human
  (never wedges). Editing the tests / this checker / the ledger to satisfy a catch is flagged as gaming: the
  block *holds* rather than releasing, so gaming is never an escape hatch.

> **False positives are fatal.** Run in WARN until precision is proven on your real sessions, *then*
> flip block. Every verdict carries file/line evidence so a wrong call is auditable, not mysterious.

## Configure

`/plugin install` enables the hooks for you. Two things a plugin **cannot** set on its own — Claude Code
only lets a plugin ship `subagentStatusLine`, not the main `statusLine`, and a plugin can't inject env
vars — so set them once (`/groundtruth-setup` walks you through it):

**Block mode (opt-in; default is warn) — no settings file needed:**
```
/groundtruth-block on        # writes .claude/groundtruth/config.json {"block": true}; /groundtruth-block off to revert
```
(Equivalently, set `GROUNDTRUTH_BLOCK=1` in your settings `env` — both are read; if neither, it stays warn.)

**Status badge (recommended) — the one manual settings line.** Add to `.claude/settings.local.json`,
pointing at the installed plugin's script:
```json
"statusLine": {
  "type": "command",
  "command": "node \"/absolute/path/to/groundtruth/hooks/groundtruth-statusline.mjs\""
}
```
It shows, every turn: `○ GT` (ran, no verdict yet) · `🟢 GT` (clean) · `🟡 GT·N` (N warnings) · `🔴 GT`
(block) · `⏳ GT` (in progress) — the always-on "it ran, here's the verdict" signal. Without it, verdicts
still write to `.claude/groundtruth/<session>.md` and `/groundtruth` prints the latest; you just lose the
passive indicator. (Note: in the VS Code extension the verdict card itself doesn't render inline — only a
*block* surfaces there — so the badge is how you see warn/clean verdicts; the terminal CLI shows the full card.)

---

## Design principle — remove the cheap wrong path

This is the generator behind every check in here. When something fails, **don't ask "why didn't it do the
right thing"** — that has no actionable answer. Ask instead:

1. **What assumption did it exploit?** (e.g. `git grep -E` ignoring `\b`; a `user`-role turn being a real ask; a writable `tasks.json` status)
2. **Why was that cheaper than verification?** (a 0-hit looks like "absent"; a deferral silently downgrades a block to a warn that's invisible in VS Code)
3. **How do we make the correct path cheaper than the wrong one?** — not just *visible*, **costly**: keep the loud signal exactly where the dodge happens.
4. **Leave a regression so the shortcut can't silently return.**

Two invariants hold every change to this standard:

> Every fix removes one cheap wrong path from the system.
>
> Every fix leaves behind a permanent invariant or regression test — otherwise you've only postponed the next failure.

A fix that only makes the wrong thing *visible* (not *costly*) is a half-fix; in an environment where warnings
are silent, "downgrade to warn" still pays the agent. The check must price the dodge, not just narrate it.

### Trust model — the verdict is only as trustworthy as the least-protected input it reads

The deepest attack isn't gaming a check — it's editing **what the check reads**. And the honest, hard truth
that three red-team passes drove home: **Groundtruth runs in the same trust domain as the agent it audits.**
The hook reads from the same filesystem the agent writes and the same environment its shell can `printenv`.
So *no on-disk artifact* the hook creates — not `config.json`, not `compiled-rules.json`, not the integrity
snapshot — is a real security boundary; an adversarial agent can rewrite or delete any of them. Each time we
"sealed" a disk sensor, the next pass stepped around the seal (forge the snapshot, NUL-byte the file, wrap the
predicate). The fix is not a better seal. It's to **anchor on the inputs the agent cannot author**, and to be
honest about the line between *evidence* and *prevention*.

**The two unforgeable anchors** (everything trustworthy is built on these):
- **The transcript** — the harness's own record of what the agent did (tool calls, Bash command text, results).
  The agent can't author its own recorded actions. So a Write/Edit to a referee file is detected from the
  *transcript* ledger (its changed path), excused only if the matching `/groundtruth-*` slash-command — a user
  turn the agent can't forge — ratifies it.
- **The git-computed diff** of the real working tree (incl. untracked content), which the agent can't fake
  short of not-writing-the-code. The Bash/MCP write channel (a referee file changed with no Write/Edit call)
  is caught by a SessionStart content-hash **snapshot** comparison — the write EFFECT, read precisely, rather
  than a substring scan of the command stream (which re-fired on stale commands, and is no longer used).

**Evidence, not prevention — and scope the evidence too.** Against an adversarial agent with shell access,
Groundtruth is at best **tamper-evident, not tamper-proof**: it cannot *prevent* a determined agent in its own
trust domain. But the evidence is **not complete** either, and the honest scope matters: the transcript is an
unforgeable *input*, but the sensor reading it (a `.claude/groundtruth/` substring + a write-verb) is still an
in-domain *classifier* — so it catches a **direct** write (`printf > .claude/groundtruth/config.json`) but
**not a laundered one**. Route the same effect through a one-line helper (`node launder.mjs …` that flips
`config.json` *and* re-forges the snapshot in the same breath) and the command sits in the transcript verbatim,
**recorded but unrecognised** → a clean green over a disabled block. The hash snapshot — the supposed catch for
"an effect laundered through a helper" — also misses it, because the helper re-forged the snapshot. So:

| Config | Direct referee write | Laundered (helper re-forges snapshot) |
|---|---|---|
| **default** (no key) | ⚠ surfaced | 🟢 **evades — recorded, not surfaced** |
| key set, shell-readable | ⚠ surfaced | 🟢 evades (helper `printenv`s the key, signs a valid forgery) |
| **key set + held out of the shell's env** | ⚠ surfaced | ⚠ surfaced (helper can't sign → unsigned forgery is rejected) |

In short: **in-session tamper-evidence is reliable only with `GROUNDTRUTH_KEY` set AND held outside the agent's
tool environment.** In the default config a determined agent can keep its tamper out of the *verdict*, not just
out of the block. The disk snapshot + signature are kept as defense-in-depth (they raise the cost and catch the
naive cases), never trusted as state — but chasing the laundered case with more in-session pattern-matching is
the cat-and-mouse this design retired three passes ago. The deterministic answer is the next paragraph.

**Two later passes tightened the multi-turn evidence** (the parts that *are* deterministically closable in-session).
Ratification is now **turn-scoped**: a `/groundtruth-*` command invoked once no longer excuses a *later* out-of-band
change (the covert re-disarm — arm rules, then Bash-`echo '[]'` over them many turns on), because the referee
snapshot carries a *signed transcript high-water mark* and only a ratifier invoked **since** it counts. And a
**signed per-target `observed` hash** means a ratifier excuses only a change made *this* turn — so a routine
command (even a read-only `/groundtruth-rules list`) can't launder a tamper *held* from a prior turn into a green.
The one in-session residual that remains is **snapshot rollback-replay** (an older validly-signed snapshot can be
restored — HMAC proves authenticity, not recency); like the laundered-helper row above, it is closed only by CI's
fresh per-run snapshot. Mechanism + regression tests in [FIXES.md](FIXES.md).

**To upgrade evidence → prevention, the platform must** (these are deployment requirements, not things the
hook can self-enforce): (1) hold `GROUNDTRUTH_BLOCK` / `GROUNDTRUTH_KEY` in an environment the agent's **Bash
tool cannot read** (otherwise `printenv` forges a valid signature); (2) keep the **transcript unwritable** by
the agent; ideally (3) run the hook in a **separate trust domain** (a pre-merge CI gate, not an in-session
hook). Under those, the env-anchored block is un-disablable and the transcript anchor is solid.

**Recommendation for security-critical use:** set `GROUNDTRUTH_BLOCK=1` and `GROUNDTRUTH_KEY=<random>` in an
environment your agent's shell can't read, and treat the in-session hook as the *evidence* layer with a
**CI/pre-merge run as the prevention layer**. `/groundtruth-block` (writing `config.json`) is convenience for
non-adversarial use only.

## Tests

```bash
node hooks/groundtruth.test.mjs   # 428 assert-based unit checks, no deps
node hooks/redteam.mjs            # LIVE adversarial harness (10 scenarios, 14 checks) — sandboxed, exits non-zero if a rail fell
```

The red-team harness is the *proven* (not asserted) counterpart: it spins up a throwaway git repo, hands the
real hook a transcript where a smart agent **actively neuters the rails** — disarms `compiled-rules.json`,
flips `config.json` to `{block:false}`, commits a fake AWS key, claims "0 pending, done" — and confirms
(A) the pre-commit halts the staged secret, (B) a *config-only* block is genuinely **defeated** by the agent's
own write (the exposure, demonstrated), and (C) an **env-anchored** block (`GROUNDTRUTH_BLOCK=1`) **holds** —
`decision:block`, citing the integrity-tamper findings and the secret — even with every rule disarmed. Blast
radius is contained: fake key, temp repo, auto-removed; it never touches a real repo or real history.

> The checks are deterministic, but many are **heuristics** (regex/string matching, not full parsing) — which
> is why the default is warn, every finding carries file/line evidence, and precision is something you confirm
> on your own sessions before flipping block.

## Status

Built: Audit mode + per-turn verify-on-Stop, all **deterministic (no LLM)** — honesty classes 1–4 + 6 + 9,
completeness (scope-miss), directive-override via doc-compiled rules behind an approval gate, the
remediation loop + anti-gaming (block → corrective handback → re-check, capped at 2 → escalate), baseline
diffing, the pre-flight intent check, plus the security checks. The semantic/LLM layer (spec-substitution,
regression detection, semantic rule-judgment) is roadmap, not shipped. See [ROADMAP.md](ROADMAP.md) for
what's next (that LLM layer + the v2 dashboard).
