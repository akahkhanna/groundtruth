# Groundtruth — roadmap

Tracks `groundtruth-architecture.md` **v0.4**. What's built, and what's left to the final sellable product.

> **Positioning guard (do not overclaim).** Groundtruth verifies that the agent did what it *said*, not
> that what it said was *right*. **Mechanics, not semantics.** Correctness still needs a test or a
> judge. The pitch is "catches the false Done, the secret, the RLS miss, the stub" — never "makes
> sure your agent did it right." The pressure to overclaim is worst while writing launch copy; this
> line exists to stop future-you doing the exact thing the tool exists to catch.

## Built

- **Audit mode** (§3) — `node hooks/groundtruth.mjs --audit`: whole-repo debt inventory (classes 2 + 4),
  findings-not-a-verdict. The doc's "cheapest first ship."
- **Verify mode** — one deterministic `Stop` hook (`type:"command"`, no LLM, no network). (An LLM
  "Tier-2" judgment hook was prototyped and cut — the shipped engine is fully deterministic.)
- **Honesty classes 1–4 + 6 + 9**: false test/build claim (incl. the *test-edited-to-pass* signal),
  stub/placeholder, silent no-op, phantom ref, **dropped symbol (dangling reference under a
  refactor/preservation claim — deterministic, receiver-gated; warn on Stop/pre-commit, block in CI)**,
  special-casing/overfit.
- **Completeness (5 scope-miss)** — a named deliverable absent from the diff (open-loop / task ledger;
  deliberately crude name-matching). **Directive-override (7)** — your docs compiled into deterministic
  predicates + enforced (the differentiator, delivered without an LLM). NOT shipped (these need the
  semantic/LLM layer): spec-substitution, 8 regression-blind, and the *semantic* versions of 5/7.
  (Class 6 was reserved for spec-substitution but is now shipped as the deterministic dropped-symbol
  check above; the semantic spec-substitution idea remains unshipped and unnumbered.)
- **Class 9 — special-casing / overfit (v0.6, warn-only)**: non-test source that detects it's under
  test/CI/audit (gaming Groundtruth's own env, or a CI/test env branch). Deterministic core only;
  **deferred** (named, not half-built): 9c hardcoded-answer-lifted-from-a-test → the LLM layer; 9d
  passes-only-the-visible-test → needs the hidden oracle, the LLM layer.
- **Output-contract hardening (v0.6, warn-only)**: a compiled rule whose `unless_re` matches everything
  is surfaced as INERT (armed-but-neutered), and an inline exemption added the same turn as the violation
  is surfaced, not silently honored — closing the "neuter the instrument without tripping tamper" hole.
  In-session this is *evidence*; enforcement of rule-integrity still belongs in the CI gate.
- **Baseline diffing (§5)** — `SessionStart` snapshots the start-ref + debt; at Stop, findings split
  introduced (flag) vs pre-existing (note), and the diff is against the start-ref so committed work is
  still seen.
- **Security Core (v0.4 §11)** — deterministic diff-scan. **C1** hardcoded key + **C2** private key are
  language/stack-general (any added line, any file). **B1** RLS-off-on-new-table + **B3** permissive
  `USING(true)`/constant-predicate policy are **Postgres/Supabase-specific** — they fire ONLY on added `.sql`
  lines and are a no-op on any other database/stack (additive, never a misfire). Block-grade; self-match-proof patterns.
- **Fail-open (v0.4)** — if `git` / the diff is unavailable (Bash blocked, etc.), the hook returns ok
  without blocking; never a false green, never wedges the turn.
- **§10 compiled rules (v0.4)** — prose rules (CLAUDE.md / skills) → deterministic predicates
  (`forbid_path` / `forbid_in_added`); `--watch-rules` PostToolUse marks dirty, the Stop agent compiles
  (warn-only until a human promotes to block), `groundtruth.mjs` enforces every Stop.
- **Pre-flight intent (§7)** — `UserPromptSubmit` warns on a thin prompt; the verdict marks a thin
  contract LOW-CONFIDENCE (completeness uncheckable).
- **Remediation loop + anti-gaming (§13/§14)** — a block-severity catch hands back a corrective payload
  (names the target state per class), then re-checks the fix on the next stop; capped at 2 attempts →
  escalate to a human, never wedges. A retry that edits the tests / this checker / the ledger is flagged
  as gaming — the block *holds* (never an escape hatch). Block-mode-gated. Pure decision + per-turn
  `.attempts` state file; regression-tested.
- WARN default / BLOCK opt-in (`GROUNDTRUTH_BLOCK=1`); verdict card → `.claude/groundtruth/<session>.md`.
- Repo-agnostic rule auto-discovery + the **`groundtruth.rules` pointer** (`.claude/groundtruth.json` `rules`).
- Plugin packaging; no-dep self-check (`hooks/groundtruth.test.mjs`, 502 checks).
- **Block visibility + test-gaming detectors (v1.0.0)** — the block/escalate outcome is stamped into
  `findings.json` and re-surfaced as a loud next-prompt banner (never silently lost), plus a best-effort
  live editor-open (`code -g` / macOS `open -b`) + toast. New warn-only anti-gaming classes: **test
  exclusion** (surefire/gradle/jest skips, coverage-threshold lowering, `-DskipTests`/`-x test` flags) and
  **test weakening** (assertion strict→loose by net count, `@Disabled`/`it.skip` on a baseline test). The
  auditor's own hook code is sealed into the integrity snapshot (info in-session, block in the keyed/CI rung).

The collapse vs the doc's plumbing: the Stop payload + transcript + `git diff HEAD` replace the
5-hook capture layer and the 4 persisted ledgers, and a single deterministic hook replaces the
`claude -p` shell-out the original design leaned on (no LLM at runtime, so no recursion problem).

---

## Phase 2 — the rest of v0.2's v1 scope

Cheapest-first. **Done (now in Built):** baseline diffing (§5) · pre-flight intent (§7) · remediation
loop + anti-gaming (§13/§14). Remaining:

- **Precision hardening → block-readiness (§12)** — *operational, not code.* Run WARN across real
  sessions, record per-class false-positive rate, tune. The gate before block ships by default. Needs
  a one-keystroke "this verdict was wrong" feedback signal (small, deferred).
- **Live-schema RLS via Supabase MCP** — evaluate `B1`/`B3` against actual `rowsecurity`/`pg_policies`,
  not just the diff — catches *existing* holes (demoed manually on prod, not yet wired into the hook).
- **Polished verdict card / free-pro split** — the ad-screenshot render; license gating
  (free: classes 1–3 + audit · pro: 4–8 + security + block + remediation).

---

## Post-launch upgrade — doc-compiled rules (§9/§10) — STARTED

The lazy version is **built** (see "§10 compiled rules" in Built): prose → `forbid_path` /
`forbid_in_added` predicates, auto-compiled warn-only when a rule file changes, enforced every Stop.
Remaining toward the full vision: a richer predicate vocabulary beyond the two kinds; a standalone
`groundtruth compile-rules` review CLI (vs the current compile-on-Stop); harder enforcement of the three
doc invariants — independence, atomic evidenced assertions, scoped `applies_when`.

---

## v2+ (doc §16 cut list — the dashboard lives here)

Cross-run history · trust-calibration over time · **multi-agent fleet dashboard**. The doc flags this
as AgentsRoom's lane, a *separate product*. The whole of v1 is the *caught-it* moment, not the dashboard.

Deeper analysis that also lands here: semantic intent↔diff matching (beyond filename heuristics for
3/5), real symbol resolution at scale (4), regression detection wired to build/typecheck/test (8).

---

## Risks to hold (doc §17)

Platform absorption (sell the **taxonomy**, not the plumbing) · false positives (warn-first,
evidence-always) · rule-source ambiguity (auto-discovery + `groundtruth.rules`) · checker cost on the
buyer's key (the per-turn audit is deterministic + free; only the opt-in `/groundtruth-rules-ai` uses the model, on demand) · gate gaming (§14 anti-gaming).
