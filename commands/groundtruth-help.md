---
description: "What Groundtruth checks, and its commands"
---

Explain to the user, concisely:

**Groundtruth** audits whether the agent actually did what it was asked — grounding every claim against the diff / tool-ledger / disk, never the agent's self-report.

It runs automatically every turn (the Stop hook) and checks:
- **Honesty & completeness — the claims contract (v2 default).** The agent ends each code-changing turn with one fenced `groundtruth-claims` manifest; Groundtruth verifies it against reality: **CA** (claimed-but-absent) — a claim the diff/transcript don't support (a `tests_pass` that never ran or ran red, a file not in the diff, a symbol not defined); **UC** (undeclared change) — a changed file no claim covers; **NC** (no contract) — a missing/invalid manifest on a code turn. Declared `deferred` items surface as the agent's own set-aside. Opt out with `GROUNDTRUTH_CONTRACT=0`.
- **Rules** — hardcoded secrets, new tables without RLS, permissive `USING(true)` policies, and project rules compiled from your docs (CLAUDE.md / skills) that were in context but broken anyway.
- **Code debt** — stub/placeholder markers, phantom imports, dropped-symbol dangling refs (a "refactor, everything preserved" that left a caller pointing at nothing); `/groundtruth-audit` inventories it repo-wide.

A verdict card is written to `.claude/groundtruth/<session>.md` each turn. With `GROUNDTRUTH_BLOCK=1` a *fixable* block-severity catch (a contract **CA**, or a built-in secret/RLS/`.env`) halts the stop, hands back a corrective, and re-checks (retry cap 2, then escalates — never wedges); otherwise it's warn-only.

**Commands:**
- `/groundtruth` — show the latest verdict card
- `/groundtruth-audit` — whole-repo deterministic debt scan
- `/groundtruth-rules` — review + approve the rules compiled from your docs (the permission gate)
- `/groundtruth-rules-ai` — opt-in model pass that proposes richer rules (routed through the same gate)
- `/groundtruth-block on｜off` — turn block mode on/off (default: warn)
- `/groundtruth-setup` — one-shot installer: writes the contract instruction, arms clean rules, badge/env
- `/groundtruth-help` — this

The honest ceiling: Groundtruth verifies the agent did what it *said*, not that what it said was *right*. **Mechanics, not semantics** — correctness still needs a test or a judge.
