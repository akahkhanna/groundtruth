<h1 align="center">Groundtruth</h1>

<p align="center">
  <strong>Every other tool tries to make your AI agent do the work right.<br>
  Groundtruth assumes it won't — and catches the moment &ldquo;done&rdquo; doesn't match the diff.</strong>
</p>

<p align="center">
  No workflow to adopt. No LLM reviewer to argue out of a verdict.<br>
  Just your agent's claim, checked against the <code>git diff</code>, deterministically.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/deterministic-no%20LLM%20%C2%B7%20no%20network%20%C2%B7%20no%20API%20key-111111?style=flat-square" alt="Deterministic: no LLM, no network, no API key">
  <img src="https://img.shields.io/badge/runs%20on-Claude%20Code-111111?style=flat-square" alt="Runs on Claude Code">
  <img src="https://img.shields.io/github/v/release/akahkhanna/groundtruth?style=flat-square&color=111111&label=release" alt="Release">
  <img src="https://img.shields.io/badge/self--checks-495%20%C2%B7%20red--team%2014%2F14-111111?style=flat-square" alt="495 self-checks, red-team 14/14">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <img src="assets/groundtruth-nerd.svg" alt="Groundtruth pushes his reading glasses down and opens the diff." width="480">
</p>

A **Claude Code plugin** that catches the false &ldquo;Done.&rdquo; Your agent reports success; Groundtruth reads the *same* turn from the outside — the request, what the agent claimed, the real `git diff`, and your project's rules — and renders a one-screen verdict before the turn can end.

It doesn't change how you work and it doesn't ask another model to grade the code. It's a **deterministic local hook: no model calls, no network, no API key.** Nothing reads the work, so nothing can be talked out of the verdict.

> **&ldquo;Isn't this like the pipeline / multi-agent-review tools?&rdquo;** No. Those make your agent follow a process, and lean on LLM reviewers that can be reasoned out of a call. Groundtruth touches neither — it treats &ldquo;done&rdquo; as a claim and the diff as the evidence. One is a process you adopt; this is a truth-check you bolt on.

## See it catch a lie

Your agent finishes and reports:

> **&ldquo;Done — added retry with exponential backoff, tests pass, and created `src/upload.test.js`.&rdquo;**

Four confident sentences. Groundtruth renders this before the turn is allowed to end:

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

Four things that weren't true — caught **deterministically**, with file/line evidence on every finding.

## Why

AI agents suffer from the *hallucination of completeness*: they'll confidently tell you a feature is shipped and tested when they left placeholders and never ran the test runner. Failures sort into three causes:

| Bucket | What happened | How Groundtruth catches it |
|---|---|---|
| **Told & Done** ✓ | instruction satisfied | nothing to do |
| **Told & Missed** ⚠ | part of the task was silently dropped | every named subtask must map to a real change |
| **Told & Ignored** ✗ | a rule in context got overridden anyway | independent rule audit, with no stake in the work |

The third is the one nothing else catches — not forgetting, but *rationalising past* a rule the agent could see. The auditor never did the work, so it never inherits the framing (&ldquo;this is just a small addition&rdquo;) that let the rule slip.

## Install

From inside Claude Code:

```
/plugin marketplace add akahkhanna/groundtruth
/plugin install groundtruth@groundtruth
```

Restart Claude Code so the hooks register. That's it — **every agent turn now gets a warn-only verdict card** (honesty, completeness, security), no further config.

Prefer to try without installing?

```
git clone https://github.com/akahkhanna/groundtruth && claude --plugin-dir ./groundtruth
```

**Requires:** Claude Code, `node` ≥ 18, and a git repo (reality = `git diff HEAD`).

From there you arm your project rules and turn on blocking in three optional stages — **audit → arm rules → block**. The full walkthrough, the status badge, and the update steps live in the **[Getting Started guide](GETTING-STARTED.md)**.

## What it checks

One deterministic `Stop` hook — no LLM, no network, always runs, ~free. It reads the claim from the Stop payload, intent + Bash evidence from the transcript, and reality from `git diff HEAD`:

- **Honesty** — false test/build claim (&ldquo;tests pass&rdquo; with no run) · stub/placeholder (`TODO`/`FIXME`/`NotImplemented`/Rust `todo!()`/Go `panic()`…) · silent no-op (claimed a file that's absent from the diff) · phantom ref (new import whose target doesn't exist) · dropped symbol (a removed function still *called* — a dangling reference under a &ldquo;refactor, everything preserved&rdquo; claim) · special-casing (code that branches on test/CI/the auditor) · **test-gaming** (a green reached by *skipping/excluding* the tests or *weakening* an existing assertion, not by fixing the code).
- **Completeness** — a named deliverable in the ask that never lands in the diff. Deliberately crude: it abstains when the ask names nothing, and when the turn is an observation rather than a request (&ldquo;the 304 is fine, no fix needed&rdquo;) so an aside is never minted into a phantom open loop.
- **Rules** *(the differentiator)* — your standing rules, **compiled from your own docs into deterministic predicates**. The doc literally says ``use `X` not `Y` `` or ``never `Z` ``, so a violation is a regex match, not a judgment call. Auto-discovered, grounded against your tree, and **proposed** — never auto-armed.
- **Security** — hardcoded secrets, an RLS-off / anon-readable new table (Postgres/Supabase), a committed `.env`.

A **semantic layer** — richer ask↔delivery matching, spec-substitution, regression detection, judging when an agent *rationalised past* a rule — needs an LLM and is **roadmap, not shipped**. The per-turn engine stays fully deterministic and offline.

## Three enforcement rungs, one engine

Each rung catches what the last can't:

**Stop** (per-turn card, warn) → **pre-commit** (any author, incl. code pasted from a chat no Stop hook saw → warn at `git commit`) → **CI** (`--diff-range origin/main..HEAD`, bypass-proof → **block** the PR).

A copy-paste hook installer and a ready [GitHub Action](.github/workflows/groundtruth.yml) make the outer two one command each.

## Commands

| Command | What it does |
|---|---|
| `/groundtruth` | Show the latest verdict card for this session. |
| `/groundtruth-audit` | Scan the whole repo for agent debt — stubs, TODOs, phantom imports. Inventory, not a verdict. |
| `/groundtruth-rules` | Review + approve rules compiled from your docs — **the permission gate**. `approve-all` arms every clean rule; `unarm <id>` silences one firing wrongly. |
| `/groundtruth-rules-ai` | **Opt-in, off by default.** A model pass reads your docs in prose and proposes rules the literal extractor missed — routed through the same grounding + approval gate. The one place a model ever touches Groundtruth. |
| `/groundtruth-block on｜off` | Opt into blocking (default is warn). Shows an itemized, fire-count-backed confirmation before it flips. |
| `/groundtruth-setup` | One-shot installer: detects what's configured, arms clean rules on consent, hands you the rest (badge, env). |

CLI (no install): `node hooks/groundtruth.mjs --audit` runs the repo audit · `--latest` prints the last verdict · `--install-pre-commit` wires a staged-diff scan · `--diff-range origin/main..HEAD` is the CI gate (exits non-zero on a block-severity finding).

## Warn vs block

- **Default: WARN.** The verdict is recorded; the turn is never disrupted. Build trust first.
- **Opt-in: BLOCK.** A block-severity finding refuses the stop and hands back a corrective payload, then re-checks the fix on the next stop — a loop **capped at 2 attempts**, then escalates to a human. Editing the tests / this checker / the ledger to satisfy a catch is flagged as gaming: the block *holds* rather than releasing. Purely **prose-grounded honesty heuristics** (e.g. a "tests pass" claim with no test run) and the test-gaming heuristics (skip/exclude, assertion-weakening) are **warn-only** — they never hard-block, because their trigger is a natural-language claim rather than a diff artifact, and a false block on that basis is the failure this tool exists to avoid. CI is the rung where such checks could later be made blocking, since there a false positive is a visible red check a human can override.

> **Block visibility (honest scope).** A block always reaches the model (the corrective payload) and is recorded to the verdict file + history. An **escalated or held** block is also recorded to the verdict file + history and, on your **next prompt**, re-surfaced as a loud `🔴 BLOCKED / ESCALATED` banner in the injected Groundtruth note — so an unresolved block is not silently dropped between turns. (A block the agent *self-resolves* within the retry loop is recorded in history but, being fixed, isn't re-surfaced.) *Live, in-the-moment* surfacing is **best-effort**: in the VS Code extension the hook's `systemMessage` is not rendered (upstream limitation), so Groundtruth additionally tries to open the verdict file in your editor (Remote-safe) or fire a desktop notification — neither is guaranteed (headless/remote sessions have no desktop; Do-Not-Disturb and notification permissions apply). Net: *an unresolved block can no longer be silently lost — it may still not be seen the instant it fires.* One more reason the hard enforcement boundary is CI, not the in-session hook.

> **False positives are fatal.** Run in WARN until precision is proven on your real sessions, *then* flip block. Every verdict carries file/line evidence, so a wrong call is auditable, not mysterious.

## Measured honestly

A verifier is only worth trusting if it's honest about its own misses.

- **Precision was rebuilt against real data, not intuition.** We read every finding Groundtruth emitted across 15 of its own sessions — 23 findings, **74% false positives** — froze them into a labeled [corpus](hooks/corpus.fixture.json), then killed them: self-match false positives in the engine went to **0**, phantom-import FPs **3 → 0**, self-checks **242 → 495**, red-team **14/14**. Independent adversarial passes then tried to break the fixes and wrote their own test cases.
- **Every fix is catalogued** — symptom → root cause → fix → regression test — in [FIXES.md](FIXES.md), including the two *critical* holes review found and the deterministic-NL limits it does **not** close.
- **Still pending, named not hidden:** a live before/after false-positive rate across a week of real sessions. Groundtruth ships an append-only history log + a `gt-harvest` reader so you can measure it on *your* repo. That number ships next — published the same way, with its misses.

The through-line: *abstain or degrade to a bounded warn outside the domain a check is provably correct in — never a clean green — and never let the audited agent shape its own verdict.*

## Languages

Mechanics, not syntax — most checks are language-general.

- **General:** false-&ldquo;tests pass&rdquo; (Go/Rust/Ruby/Java/.NET/Python/JS runners), stub/placeholder, silent no-op, completeness, directive-override, secrets, env exposure.
- **JS/TS + Ruby only:** phantom relative-import resolution — it resolves by file existence. Package-qualified languages (Python/Go/Rust/Java/C#) **abstain** rather than false-flag.
- **Postgres/Supabase only:** the RLS checks — they fire solely on added `.sql` lines.

## Trust model — honest scope

Groundtruth runs in the **same trust domain as the agent it audits**: same filesystem, same environment. So no on-disk artifact it creates is a real security boundary — an adversarial agent can rewrite any of them. Against an agent with shell access, Groundtruth is **tamper-evident, not tamper-proof**.

What makes it trustworthy is anchoring on the two inputs the agent *can't* author: the **transcript** (the harness's own record of tool calls) and the **git-computed diff** of the working tree. In-session tamper-evidence is reliable with `GROUNDTRUTH_KEY` set and held outside the agent's shell env; to upgrade *evidence → prevention*, run the hook in a separate trust domain (a pre-merge CI gate).

The full adversarial analysis — three red-team passes, the laundered-helper evasion, the fixes and their limits — is in **[SECURITY.md](SECURITY.md)** and [FIXES.md](FIXES.md).

## Tests

```bash
node hooks/groundtruth.test.mjs   # 495 assert-based unit checks, no deps
node hooks/redteam.mjs            # live adversarial harness (10 scenarios, 14 checks), sandboxed
```

The red-team harness is the *proven* counterpart: it spins up a throwaway repo, hands the real hook a transcript where a smart agent actively neuters the rails — disarms rules, flips config to `{block:false}`, commits a fake AWS key, claims &ldquo;0 pending, done&rdquo; — and confirms the pre-commit halts the secret, a config-only block is genuinely *defeated* (the exposure, demonstrated), and an **env-anchored** block **holds**. Blast radius is contained: fake key, temp repo, auto-removed.

## Status

Shipped (**v1.0.0**): audit mode + per-turn verify-on-Stop, all deterministic — honesty, completeness, doc-compiled rule enforcement behind an approval gate, the remediation loop + anti-gaming, test-gaming detectors (skip/exclude + assertion-weakening), security checks, and never-silently-lost block visibility with a best-effort live pop. The auditor's own code is sealed into the integrity snapshot. The semantic/LLM layer is roadmap. See [ROADMAP.md](ROADMAP.md).

## Contributing

The bar is precision-first: a check earns its place only if it's provably correct in a defined scope, and a false positive is treated as fatal. Run `node hooks/groundtruth.test.mjs` and `node hooks/redteam.mjs` before opening a PR, and see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the design principles, the fixture/regression expectations, and how to propose a new finding class.

## Documentation

- **[Getting Started](GETTING-STARTED.md)** — install, arming rules, warn → block, status badge, updating, troubleshooting
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — design principles and how to add a check
- **[FIXES.md](FIXES.md)** — every fix: symptom → root cause → fix → regression test
- **[SECURITY.md](SECURITY.md)** — the adversarial trust model and how to report privately
- **[ROADMAP.md](ROADMAP.md)** — what's next: the semantic/LLM layer and the v2 dashboard

## License

[MIT](LICENSE) © Akash Khanna
