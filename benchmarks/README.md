# Benchmarks — measure Groundtruth's precision, honestly

A verifier is only worth trusting if it publishes its own miss rate. This directory holds the two measurements — one you can reproduce **now** from frozen data, one you run on **your own** repo over a week — and refuses to fabricate the headline number before the data exists.

## 1. Captured precision (reproducible now)

The precision work was driven by real data: every finding Groundtruth emitted across **15 of its own recent sessions** (auditing itself), hand-labeled FP / TP / borderline and frozen in [`../hooks/corpus.fixture.json`](../hooks/corpus.fixture.json).

```bash
node corpus-precision.mjs
```

Prints the FP/TP breakdown by label and bucket, and the false-positive rate **at capture** (majority FP — the number the v0.8.0 precision work set out to cut). Every FP on the corpus carries the phase that fixed it; the fix + regression test is in [`../FIXES.md`](../FIXES.md).

**Dogfood after the fixes** (reproduce with `node ../hooks/groundtruth.mjs --audit` from the repo root): self-match false positives in the engine source went to **0** (`Class 2`) and phantom-import FPs **3 → 0** (`Class 4`); self-checks **242 → 424**, red-team **14/14**.

## 2. Live false-positive rate on your repo (the pending headline)

The honest headline — *"across a week of real sessions, Groundtruth's false-positive rate is X%"* — has to be measured on real sessions, not asserted. Groundtruth writes an append-only, one-line-per-turn log at `.claude/groundtruth/history.jsonl`; this harvester reads it:

```bash
# run it in warn mode for a week (the default), then:
node gt-harvest.mjs ~/your-repo --days 7
# or point at a parent folder to sweep every repo at once
```

It prints a summary (turns seen, % with findings, verdicts, findings by class) and writes **`gt-week.csv`** — one row per finding with a blank `false_positive?` column. Fill that column honestly, and:

```
precision = (finding rows − false positives) / turns
```

That number — published with its misses, not just its wins — is the one worth publishing. It is **not** in this README yet, on purpose: the instrument shipped in v0.9.0, so the first honest week of v0.9.0 data doesn't exist until a week after you install it. Publishing it early would be the exact overclaimed "done" Groundtruth exists to catch.

### First harvest (2026-07, v0.9.2→0.9.3 dev) — why it is *not* published as a rate

A 30-day `gt-harvest` over a live workspace saw **74 real Stop turns · 45 findings**. We deliberately do **not** turn that into a headline FP rate, because it is not representative: **43 of the 45 findings came from a single anomalous session** — building the groundtruth repo *from* a different repo's workspace — so the sample is 96% one session's artifacts, not normal use. What it *did* surface honestly:

- The **integrity keyless-snapshot warn was the dominant recurring FP (17 of 45)** — now fixed in **v0.9.3** (a keyless baseline under a later-set key downgrades to a quiet info note, not a tamper warn). Real-session data pointed the fix at the right target.
- The **cross-workspace silent-no-op** (claiming a change to a file outside the audited workspace, so it's "absent from the diff") — a documented limitation: Groundtruth audits the *session's* workspace (`CLAUDE_PROJECT_DIR`/cwd), not files edited in another repo. **Practical guidance:** for a meaningful, quiet verdict, match the session's workspace to the repo you're editing (one repo per session); if you must touch two, treat the out-of-workspace repo's findings as noise and rely on that repo's own tests. Even a multi-root editor window anchors the referee to one project dir — it doesn't split across both.

The representative headline — a week of **in-workspace, post-0.9.3** sessions — remains the pending number. This first pass validated the harvester and the 0.9.3 integrity fix; it did not (and could not honestly) produce the rate.

### Self-audit during dev (2026-07, star-ask feature) — a borderline FP, logged not scored

Building the one-time "star the repo" ask, Groundtruth's own `--intent` audit flagged a **Class 9 (special-casing / overfit)** warn on the feature's first-pass diff: the line `… renderCard(…) + starLine(cwd, findings.some(f => f.sev === 'block'))` tripped the "non-test source branches on evaluator/verdict state" heuristic on `f.sev === 'block'`. It was a **borderline false positive** — the branch was a legitimate "don't ask on a block" gate, not test-gaming — but it pointed at real coupling that a review pass independently called out, and the fix (moving the ask off the card and onto the `additionalContext` channel) deleted the line, so a re-audit of the final diff came back clean (Honesty ✓ Rules ✓ special-casing ✓). Recorded as an honest data point, **not** folded into a precision rate (n=1, dev session). The new `shouldAskStar` gate added **4 self-checks (396 → 400)**.

### Class-1 precision pass (2026-07, v0.9.4) — driven by two real sessions

Two sessions drove a batch of Class-1 ("false test/build claim") fixes — the honesty check that is the tool's core value, and its most-felt false positive.

- **A dev session spent *discussing* the check kept tripping it.** Class-1 text-matches claims, so a message that quotes its own trigger words ("tests/build … pass/green") self-matches, and a counterfactual ("even if I'd watched the build go green") slipped a too-narrow proximity window. Fixed in **v0.9.4**: the hypothetical/negation guard is now sentence-scoped, its verb set mirrors the claim's, and quoted-pattern self-matches are suppressed. An adversarial verification pass then found **five more holes** the first cut missed (a false-block regression, a re-opened grounding hole, and three block-rail evasions) — all fixed and pinned with regression tests. The net *strengthens* true catches (a real "Tests pass." is no longer silenced by a later hypothetical sentence), and self-checks went **400 → 424**. Details in [`../FIXES.md`](../FIXES.md) (v0.9.4).

- **A live Vercel session showed the check working — and a real limitation.** In an `ERR_REQUIRE_ESM` post-mortem, the recurring false-green warning had *changed the operator's behavior*: the turn that stated plainly what it **couldn't** verify ("verifies on the next staging cron; can't call the deployed key locally") came back **🟢 Honesty** — exactly the honest-claiming the check nags toward (a true-positive *outcome*, not just a flag). That same card also carried a **stale open-loop false positive** — a task tracking the ESM fix stayed "pending" though the fix had shipped (staging `95e51b1`, prod `0894c46`, `.mjs`→CJS) — because the auditor grades **this turn's diff**, not git history or another worktree where the fix lives. Same family as the documented cross-workspace limit; the resolution is the human's `defer`, **not** the agent clearing its own task (the integrity model working as intended — an agent can't mark its own work "done"). The incident's root tell — a "tests pass" claim backed only by `node --check` — is now a v0.9.4 warn.

## Method notes

- **Warn mode** (the default) so nothing is blocked while you collect — you're measuring the auditor, not gating work.
- **Label FP conservatively:** a finding is a false positive only if a fair reader would call it wrong, not merely annoying. Borderline → not FP.
- **The append-log is required for a real count.** Without it the harvester falls back to per-session snapshots, which overwrite each turn and undercount — it warns you when that happens.
