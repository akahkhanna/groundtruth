# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Groundtruth is a **Claude Code plugin** (distributed via the plugin marketplace, not npm) that catches the false "Done." It's a **deterministic local hook** — no LLM calls, no network, no API key. It reads an agent turn from the outside (the request, the claim, the real `git diff`, the project rules) and renders a one-screen verdict before the turn ends.

Design invariant, enforced in review: **a false positive is treated as fatal.** A check earns its place only if it's provably correct in a defined scope. Outside that scope a check must **abstain or degrade to a bounded warn — never a clean green.** When adding or changing a check, this is the bar. See `CONTRIBUTING.md`.

## Commands

```bash
node hooks/groundtruth.test.mjs   # 596 assert-based unit checks, no deps, no framework
node hooks/redteam.mjs            # live adversarial harness (10 scenarios, sandboxed throwaway repos)
npm test                          # alias for the unit checks
npm run check-self                # same, but echoes the exit code as a GREEN/RED done-verdict
```

The test file is a flat sequence of `ok(label, cond)` asserts — there is **no single-test runner**; you run the whole file (it's fast). It imports the pure exports of `groundtruth.mjs`/`compile-rules.mjs`/`symbol-integrity.mjs` directly, so **a new check is only testable if it's exported and pure.** Add a regression test in the same style next to the code it covers, and log the fix in `FIXES.md` (symptom → root cause → fix → regression test).

CLI entry points (all on `hooks/groundtruth.mjs`, dispatched in `main()`):
```bash
node hooks/groundtruth.mjs --audit                    # whole-repo debt inventory (stubs/TODOs/phantom imports)
node hooks/groundtruth.mjs --latest                   # print the last verdict card
node hooks/groundtruth.mjs --diff-range origin/main..HEAD   # CI gate: exits non-zero on a block finding
node hooks/groundtruth.mjs --install-pre-commit       # wire a staged-diff scan into .git/hooks/pre-commit
node hooks/compile-rules.mjs [repo-root]              # (re)compile doc rules → proposed-rules.json
```

## Architecture

Everything is one big deterministic engine in `hooks/groundtruth.mjs` (~2300 lines). It has **no dependencies** — pure `node:*` stdlib. The other `.mjs` files are satellites of it.

**Three inputs, and only two are trusted.** The agent shares Groundtruth's trust domain (same fs, same env), so on-disk artifacts aren't a security boundary. Trust anchors on the two inputs the agent *can't* author: the **transcript** (harness record of tool calls) and the **git-computed diff**. Any new check should ground on those, not on agent-writable state. See `SECURITY.md` for the full adversarial model.

**One engine, five hook events, several CLI surfaces.** `hooks/hooks.json` wires the plugin:
- `SessionStart` (`--session-start`) — snapshots the baseline ref + pre-existing debt + a signed referee-file snapshot, and compiles doc rules. Stop diffs against this baseline, **not HEAD** (so work committed mid-session is still seen — a real failure mode this fixes).
- `UserPromptSubmit` (`--intent`) — warns on a too-thin prompt (completeness can't be checked), and injects the *prior* turn's findings into context so a warn isn't silently lost in VS Code.
- `PostToolUse[Edit|Write|MultiEdit]` (`--watch-rules`) — recompiles doc rules when a rule-source doc is edited mid-session.
- `Stop` / `SubagentStop` (no arg) — the main verdict path.

**The Stop path** (`main()` starts ~line 1857; the no-arg branch is the fallthrough after every flag branch, ~line 2100): load baseline → `git diff <baseRef>` → parse transcript for intent/Bash-evidence/tool-ledger → merge the **tool Diff Ledger** (reconstructed Edit/Write so new untracked files are visible) → build a wider `scanDiff` (adds untracked file *content* + MCP SQL, for security scanners only) → run `analyze()` + compiled rules + dropped-symbol check + referee-tamper check → render + persist to `.claude/groundtruth/<session>.md`.

Note the two diff variables — this distinction matters when editing: `diff`/`gitDiff` (authored changes) drives the ledger/open-loops/tamper; `scanDiff` (authored + untracked + MCP) drives `analyze`'s content checks. Reading untracked content into the *authored* diff would false-ground a task "done" on any prose mention of a filename.

**`analyze()`** (exported, ~line 438) is the pure core: takes `{claim, diff, bashCmds, results, cwd}`, returns findings. Being a pure function is what makes the corpus/unit tests possible — they call it directly. Keep it pure.

**Finding classes** live in `CLASS_NAME` (~line 39). The buckets map to the README's failure taxonomy (Told&Missed / Told&Ignored). Severity is `block` | `warn` | `info`. Prose-grounded honesty heuristics and test-gaming heuristics are **warn-only by design** — they never hard-block, because their trigger is a natural-language claim and a false block there is exactly the failure this tool exists to avoid.

**Satellite files:**
- `hooks/symbol-integrity.mjs` — Class 6 (`checkDroppedSymbols`): a def the diff removed, defined nowhere, still *called* → dangling ref under a "preserved" claim. Receiver-gated to kill FPs.
- `hooks/compile-rules.mjs` — the rule compiler. EXTRACT (regex over backtick'd `` `X` not `Y` ``/`` never `Z` `` in your docs) → GROUND (grep against the tree; already-matching = `review`, clean = `armable`) → **PROPOSE, never arm**. `/groundtruth-rules` is the human approval gate that writes `compiled-rules.json`. `compileRuleRe` is shared with the runtime for grounder⇄runtime parity.
- `hooks/groundtruth-statusline.mjs` / `.sh` — status badge.
- `commands/*.md` — the slash commands (`/groundtruth`, `-audit`, `-rules`, `-rules-ai`, `-block`, `-setup`, `-help`).
- `benchmarks/` — `corpus-precision.mjs` runs `analyze()` over the labeled `hooks/corpus.fixture.json` (frozen real findings, ~74% were FPs — the precision-rebuild dataset); `gt-harvest.mjs` reads the append-only `.claude/groundtruth/history.jsonl`.

## Enforcement & config

- **Warn is the default.** Blocking is opt-in via `GROUNDTRUTH_BLOCK=1` (or `/groundtruth-block on`). A block refuses the stop, hands back a corrective payload, re-checks on the next stop — **capped at 2 attempts** then escalates to a human. Editing the tests/checker/ledger to satisfy a catch is flagged as gaming and the block *holds*.
- `GROUNDTRUTH_KEY` (held **outside** the agent's shell env) signs the referee-file snapshot — upgrades laundered-tamper detection from evidence toward prevention. Without it, integrity is best-effort. The real enforcement boundary is a **CI/pre-merge gate**, not the in-session hook.
- Cross-workspace note: for a meaningful verdict, the Claude Code workspace must match the repo you're editing (reality = `git diff HEAD` of *this* tree).

## Conventions to match

- **Dense root-cause comments.** The code carries long comments explaining *why* a line is the way it is — usually a specific FP/FN it fixed, often naming the version. Match this: when you fix a bug, the comment names the failure it prevents, not just what the code does. This is the house style, not clutter.
- **Fail-open on infra, fail-loud on silent-inertness.** Git/parse errors are swallowed (never break a turn). But a check that could go *silently inert* (a shallow CI checkout → empty diff → false pass) must **fail loud and exit non-zero** — a silent pass on a broken PR is the cardinal sin. Grep helpers must distinguish `git grep` exit-1 (clean no-match) from a real error.
- **Cross-platform:** shell out with `execFileSync` + arg arrays (no shell string — Windows `cmd.exe` broke POSIX-quoted patterns and silently disabled checks). Run-as-main guards use `pathToFileURL`.
