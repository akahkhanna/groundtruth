<h1 align="center">Groundtruth</h1>

<p align="center">
  <strong>Your agent signs its work. Groundtruth notarises it.</strong>
</p>

<p align="center">
  Every code-changing turn ends with a short manifest of what the agent claims it did.<br>
  Groundtruth checks that manifest against the real <code>git diff</code>, deterministically — line by line.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/deterministic-no%20LLM%20%C2%B7%20no%20network%20%C2%B7%20no%20API%20key-111111?style=flat-square" alt="Deterministic: no LLM, no network, no API key">
  <img src="https://img.shields.io/badge/runs%20on-Claude%20Code-111111?style=flat-square" alt="Runs on Claude Code">
  <img src="https://img.shields.io/github/v/release/akahkhanna/groundtruth?style=flat-square&color=111111&label=release" alt="Release">
  <img src="https://img.shields.io/badge/self--checks-453%20%2B%20180%20%C2%B7%20red--team%2027%2F27-111111?style=flat-square" alt="633 self-checks (453 engine + 180 contract), red-team 27/27">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <img src="assets/groundtruth-nerd.svg" alt="Groundtruth pushes his reading glasses down and opens the diff." width="480">
</p>

A **Claude Code plugin** that catches the false &ldquo;Done.&rdquo; Your agent finishes a turn and declares what it did; Groundtruth reads the declaration and the reality — the real `git diff`, the harness's own record of what actually ran — and renders a one-screen verdict before the turn can end.

It doesn't change how you work and it doesn't ask another model to grade the code. It's a **deterministic local hook: no model calls, no network, no API key.** Nothing reads the work, so nothing can be talked out of the verdict.

> **&ldquo;Isn't this like the pipeline / multi-agent-review tools?&rdquo;** No. Those make your agent follow a process, and lean on LLM reviewers that can be reasoned out of a call. Groundtruth touches neither — it treats &ldquo;done&rdquo; as a claim and the diff as the evidence. One is a process you adopt; this is a truth-check you bolt on.

## The idea: stop parsing English, start auditing paperwork

v1 of this tool read the agent's closing essay and *guessed* what it had promised, then checked the guess against the code. Guessing from free prose is an unbounded problem — you cannot enumerate a natural language with patterns, so every fix just moved the failure to the next phrasing.

**v2 inverts it.** The agent ends every code-changing turn with one small, fixed **claims block** — a manifest, in a grammar Groundtruth wrote. Then two bounded checks: everything on the manifest must exist in reality, and everything in reality must be on the manifest. Lying on the form is mechanically detectable; refusing to fill in the form is itself the finding. You stop parsing an infinite language and start **validating a grammar you wrote.**

We call the engine **declare-then-verify**, and the two directions of the check form a **pincer** — more on that below.

## The claims block

One fenced block, JSON — so `JSON.parse` is the whole parser:

````
```groundtruth-claims
{
  "v": 1,
  "task": "add auth middleware and wire it into the router",
  "status": "complete",
  "claims": [
    { "t": "created",  "file": "src/auth.mjs", "symbols": ["requireAuth"] },
    { "t": "modified", "file": "src/app.mjs" },
    { "t": "tests_pass", "cmd": "npm test" },
    { "t": "deferred", "what": "e2e coverage", "why": "needs staging env" }
  ]
}
```
````

A **closed set of eight claim types**: `created` · `modified` · `deleted` · `renamed` · `tests_pass` · `build_pass` · `deferred` · `no_change`. `status` is `complete | partial | blocked` — and `partial`/`blocked` must name what's outstanding with a `deferred` entry, so &ldquo;mostly done&rdquo; can't be left conveniently vague.

`/groundtruth-setup` writes the one-line instruction that teaches your agent this form into your `CLAUDE.md`. Once it's there, the session is *contract-aware* and an omitted manifest becomes block-eligible — and because awareness is anchored on the **session baseline**, an agent can't strip the instruction mid-turn to dodge the block (the strip is surfaced instead).

## The three findings

Groundtruth reads the manifest, then reality (the `git diff`, the transcript's command evidence, the symbols the diff actually added), and emits at most three kinds of finding — or nothing:

| Finding | Means | Severity | The evasion it closes |
|---|---|---|---|
| **NC** — no contract | the block is missing, malformed, or schema-invalid on a turn that changed code | warn — **block-eligible once `/groundtruth-setup` has run** (see below) | dodging the form entirely |
| **CA** — claimed but absent | a claim reality doesn't support: a file not in the diff, a `tests_pass` that never ran or ran red, a symbol not defined in the added code | **block-tier** | inventing work to look productive |
| **UC** — undeclared change | a changed file no claim covers | warn | hiding sloppy work by omission |

The two directions are the **pincer**: omit a claim → `UC`. Invent one → `CA`. Dodge the form → `NC`. Bury a lie in the surrounding prose → *irrelevant*, because prose is no longer audited. The only path through is to declare exactly what you did — and to have done it.

Even a green `tests_pass` gets sniffed before it's blessed: a run whose exit was force-succeeded (`npm test || true`), a syntax/type check posing as a test run, output that prints failures despite a zero exit, a green that predates the last source edit, a run filtered to a subset — each earns a bounded warn- or info-tier note, never a quiet pass.

## See it catch a lie

Your agent finishes and reports:

> **&ldquo;Done — added retry with exponential backoff to the S3 client, wrote the test, and the suite is green.&rdquo;**

````
```groundtruth-claims
{
  "v": 1,
  "task": "add retry with backoff to the S3 client, plus a test",
  "status": "complete",
  "claims": [
    { "t": "modified", "file": "src/upload.js" },
    { "t": "created",  "file": "src/upload.test.js" },
    { "t": "tests_pass", "cmd": "npm test" }
  ]
}
```
````

Confident prose, tidy manifest. Groundtruth compares it to reality — `src/upload.test.js` is nowhere in the diff, no test command appears in the session's command record, and `src/config.js` was quietly edited too — and renders this (illustrative card; the finding text is what the engine actually emits):

```
GROUNDTRUTH · claims contract
  TASK  add retry with backoff to the S3 client, plus a test

  🔴 CA  claimed created src/upload.test.js, but it is absent from the diff
  🔴 CA  claimed `npm test` passed, but no such command ran this session
  🟡 UC  undeclared change: src/config.js (M) is in the diff but no claim covers it

  VERDICT  🔴 ISSUES — 2 block-tier · 1 warn      (warn mode: recorded, not enforced)
  ⚪ Deterministic (no LLM). The manifest is the claim; the diff is the evidence.
```

Notice why the verdict is unarguable. The first finding is a set-membership test: the declared path against the files `git` says changed. The second is a lookup in the harness's own command ledger — a record the agent can't author. The third is the same membership test run in reverse. No judgment calls, no model, nothing to argue with. Just the form, and the facts.

## What v2 buys over v1

- **`UC` is new capability, not a refinement.** v1 could only check what it managed to extract from prose. v2 audits the **whole diff** by construction — a file the agent quietly touched and never mentioned cannot slip through.
- **`CA` is exact.** &ldquo;claimed `created src/upload.test.js`, absent from the diff&rdquo; is a declared path compared to a git-computed file list — not a regex-guessed noun phrase. The false-positive treadmill of prose parsing is gone.
- **Precision is structural.** An honest, complete manifest produces zero findings. That's not a tuning outcome; it's what the design leaves possible.

## What stays exactly as it was

Everything that reads the **diff** — the code-facing half — is unchanged, because code is a formal language and those checks were always sound: hardcoded secrets, RLS-off tables, a committed `.env`, stub/placeholder markers, dropped-symbol dangling refs (a &ldquo;refactor, everything preserved&rdquo; that left a caller pointing at nothing), test exclusion/weakening, rules compiled from your own docs behind a human approval gate, and Rule Zero tamper-evidence. The claims contract replaced only the language-facing half.

## Abstain over guess

The founding rule, now structural: **a false positive is treated as fatal**, so any check that can't be decided from the reality it was given emits *nothing* rather than a wrong finding.

- No transcript → `tests_pass`/`build_pass` claims abstain (never a false &ldquo;that never ran&rdquo;).
- A file whose language can't be lexed → symbol claims abstain.
- Excluded paths (lockfiles, generated artifacts, out-of-repo scratch) → no `UC`, no `NC` nag.
- A pure Q&A turn that changed nothing → no contract required, no finding.

## Install

From inside Claude Code:

```
/plugin marketplace add akahkhanna/groundtruth
/plugin install groundtruth@groundtruth
```

Restart Claude Code so the hooks register, then run `/groundtruth-setup` — it writes the one-line contract instruction into your `CLAUDE.md`. **Requires:** Claude Code, `node` ≥ 18, and a git repo (reality = the git-computed diff).

Want the contract off? `GROUNDTRUTH_CONTRACT=0` disables it — the diff-facing checks (secrets, RLS, stubs, dropped symbols, compiled rules) keep running; only the claims-contract layer (`NC`/`CA`/`UC`) goes quiet. (The v1 prose honesty layer is retired, not a fallback.)

The full walkthrough — arming rules, the status badge, warn → block, updating — lives in the **[Getting Started guide](GETTING-STARTED.md)**.

## Warn vs block

- **Default: WARN.** Every verdict is recorded; the turn is never disrupted. Build trust first.
- **Opt-in: BLOCK** — `/groundtruth-block on` (or `GROUNDTRUTH_BLOCK=1`). A `CA` (and, in a **contract-aware** repo — one where `/groundtruth-setup` has written the instruction — an `NC`) then refuses the stop and hands the gap back to the agent, re-checks on the next stop — **capped at 2 attempts**, then escalates to a human. `UC` stays warn. Editing the tests, this checker, or the ledger to satisfy a catch is flagged as gaming, and the block *holds* rather than releasing.

Run in warn until precision is proven on your real sessions, *then* flip. Every finding carries its evidence, so a wrong call is auditable, not mysterious.

## Three enforcement rungs, one engine

**Stop** (per-turn card) → **pre-commit** (`--install-pre-commit`: catches any author, including code pasted from a chat no Stop hook ever saw) → **CI** (`--diff-range origin/main..HEAD`, exits non-zero on a block finding — the rung an in-session agent can't reach). A ready [GitHub Action](.github/workflows/groundtruth.yml) makes the last one one commit.

## Commands

| Command | What it does |
|---|---|
| `/groundtruth` | Show the latest verdict card for this session. |
| `/groundtruth-audit` | Scan the whole repo for agent debt — stubs, TODOs, phantom imports. Inventory, not a verdict. |
| `/groundtruth-rules` | Review + approve rules compiled from your docs — **the permission gate**. Nothing arms without you. |
| `/groundtruth-rules-ai` | **Opt-in, off by default.** A model pass proposes rules the literal extractor missed — routed through the same grounding + approval gate. The one place a model ever touches Groundtruth. |
| `/groundtruth-block on｜off` | Opt into (or out of) blocking. Default is warn. |
| `/groundtruth-setup` | One-shot installer: writes the contract instruction, arms clean rules on consent, hands you the rest. |
| `/groundtruth-help` | Quick reference for the commands and the verdict card. |

CLI, no install: `node hooks/groundtruth.mjs --audit` · `--latest` · `--install-pre-commit` · `--diff-range origin/main..HEAD`.

## Hardened in public

A verifier is only worth trusting if it documents its own misses. The contract engine was hardened across **repeated adversarial and code-review passes before it became the default** — every finding a false positive on honest work or a silent false green, every fix locked with a regression test, all catalogued C-1 through C-9 in [FIXES.md](FIXES.md). A sample of what got killed:

- An absolute-vs-relative path mismatch that turned *every honest `created`* into a block. *(C-1)*
- A planted `++ b/ghost.js` content line that laundered a phantom file into a green — closed by parsing hunks by their declared line counts, so agent-controlled content can never mint a file. *(C-2)*
- `echo "npm test"` blessing a `tests_pass` that never ran; a red re-run laundered by an earlier green. *(C-3)*
- A gitconfig with nonstandard diff prefixes silently poisoning every path on every turn. *(C-8)*

Current standing: **453 engine checks + 180 contract checks** (633 self-checks total), and a live sandboxed adversarial harness at **red-team 27/27** — a throwaway repo, a genuinely hostile scripted agent, the real hook.

The through-line: *abstain or degrade to a bounded warn outside the domain a check is provably correct in — never a clean green — and never let the audited agent shape its own verdict.*

## Trust model — honest scope

Groundtruth runs in the **same trust domain as the agent it audits**, so no on-disk artifact it writes is a security boundary — in-session it is **tamper-evident, not tamper-proof**. What makes it trustworthy is anchoring on the two inputs the agent *can't* author: the **transcript** (the harness's own record of tool calls) and the **git-computed diff**. To upgrade evidence into prevention, run the same engine as a pre-merge CI gate — a trust domain the agent's shell can't reach. The full adversarial analysis is in **[SECURITY.md](SECURITY.md)**.

## Tests

```bash
node hooks/groundtruth.test.mjs   # assert-based unit checks — no deps, no framework
node hooks/redteam.mjs            # live adversarial harness, sandboxed throwaway repos
```

## Contributing

The bar is precision-first: a check earns its place only if it's provably correct in a defined scope, and a false positive is treated as fatal. Run both suites before opening a PR, and see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the design principles and how to propose a new finding class.

## Documentation

- **[Getting Started](GETTING-STARTED.md)** — install, arming rules, warn → block, status badge, troubleshooting
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — design principles and how to add a check
- **[FIXES.md](FIXES.md)** — every fix: symptom → root cause → fix → regression test
- **[SECURITY.md](SECURITY.md)** — the adversarial trust model and how to report privately
- **[ROADMAP.md](ROADMAP.md)** — what's next

## License

[MIT](LICENSE) © Akash Khanna
