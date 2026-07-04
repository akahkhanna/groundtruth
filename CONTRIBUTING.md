# Contributing to Groundtruth

Thanks for looking. Groundtruth is a deterministic verifier, so the bar for a change is a little different from a normal tool: **a check is only worth adding if it's provably correct in a defined scope, and false positives are treated as fatal.** These notes keep contributions aligned with that.

## Run the checks first

No dependencies to install — everything runs in raw Node.

```bash
node hooks/groundtruth.test.mjs   # assert-based unit checks
node hooks/redteam.mjs            # live adversarial harness (sandboxed; exits non-zero if a rail fell)
```

The red-team harness is the *proven* counterpart to the unit tests: it spins up a throwaway git repo, hands the real hook a transcript where an agent actively neuters the rails, and confirms the rails hold. Both must pass before a PR is ready.

## The design principle behind every check

When a check misses something, **don't ask "why didn't the agent do the right thing"** — that has no actionable answer. Ask instead:

1. **What assumption did it exploit?**
2. **Why was that cheaper than verification?**
3. **How do we make the correct path cheaper than the wrong one** — not just visible, but *costly*?
4. **Leave a regression so the shortcut can't silently return.**

Two invariants hold on every change:

> Every fix removes one cheap wrong path from the system.
>
> Every fix leaves behind a permanent invariant or regression test — otherwise you've only postponed the next failure.

A fix that only makes the wrong thing *visible* (not *costly*) is a half-fix. In an environment where warnings are silent, "downgrade to warn" still pays the agent.

## Precision is the product

- **False positives are fatal.** A check that false-fires teaches users to ignore the card, which breaks everything. When in doubt, **abstain** — degrade to a bounded warn, or emit nothing, rather than a wrong finding.
- **Ground every check against real data.** New or changed checks should come with fixtures — ideally drawn from real sessions, not intuition. If you're fixing a false positive, add the exact case that fired as a fixture so it can't regress.
- **Scope honestly.** If a check is only correct for some languages (e.g. phantom-import resolution is unambiguous only where imports are path-relative), it must *abstain* elsewhere rather than guess. Document the scope.
- **Never let the audited agent shape its own verdict.** Checks anchor on inputs the agent can't author — the transcript and the git-computed diff. A check that reads an agent-writable on-disk artifact as *state* is not trustworthy; treat such artifacts as defense-in-depth only.

## Proposing a new finding class or rule

Open an issue first describing:

- The real failure it catches (ideally a transcript + diff that shows it).
- Why it can be decided **deterministically** (regex / string / diff structure), or an honest note that it needs the semantic/LLM layer — which is roadmap, not the per-turn engine.
- The abstain conditions: where it must *not* fire.

Then, in the PR: the check, the fixtures that prove it, and an entry in `FIXES.md` (symptom → root cause → fix → regression test).

## Pull request checklist

- [ ] `node hooks/groundtruth.test.mjs` passes
- [ ] `node hooks/redteam.mjs` passes
- [ ] New/changed behavior has a fixture or regression test
- [ ] `FIXES.md` updated if this closes a hole or changes a finding
- [ ] Scope and abstain conditions documented for any new check
- [ ] No new runtime dependency, no network call, no API key (the per-turn engine stays deterministic and offline)

## Reporting a security issue

The adversarial trust model and its known limits are documented in [SECURITY.md](SECURITY.md). If you've found a way to defeat a rail that isn't already described there, please report it privately rather than opening a public issue — see SECURITY.md for how.

## Style

Match the surrounding code. Small, well-scoped PRs review faster than large ones. If a change is exploratory, mark it as such and expect a conversation about scope before merge.
