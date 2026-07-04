# Security

Groundtruth is a verification hook, so its security story is unusual: the honest scope matters more than a reassuring claim. This document states exactly what it can and cannot guarantee, and how to run it when the guarantee needs to be strong.

The one-line version: **against an adversarial agent with shell access, Groundtruth is tamper-evident, not tamper-proof — and only reliably tamper-evident when `GROUNDTRUTH_KEY` is set and held outside the agent's environment.** Everything below is the reasoning behind that sentence.

## Reporting a vulnerability

If you've found a way to defeat a rail — evade a finding, disarm a block, or launder a tamper into a clean verdict — that isn't already described below or in [FIXES.md](FIXES.md), please report it **privately** rather than opening a public issue.

- Preferred: **GitHub private vulnerability reporting** — the repository's **Security → Report a vulnerability** tab. (Maintainer: enable this under Settings → Code security if it isn't already on.)
- A minimal reproduction — a transcript + diff, or a throwaway repo — is worth far more than a description. The red-team harness (`node hooks/redteam.mjs`) is the right shape to model it in.

Expect a response acknowledging the report; confirmed rail-defeats are catalogued in FIXES.md with a regression test once fixed.

## Threat model — the trust domain

The deepest attack isn't gaming a check; it's editing **what the check reads**. And the hard truth three red-team passes drove home:

> Groundtruth runs in the **same trust domain as the agent it audits.**

The hook reads from the same filesystem the agent writes and the same environment its shell can `printenv`. So **no on-disk artifact the hook creates** — not `config.json`, not `compiled-rules.json`, not the integrity snapshot — is a real security boundary. An adversarial agent can rewrite or delete any of them. Each time a disk sensor was "sealed," the next pass stepped around the seal: forge the snapshot, NUL-byte the file, wrap the predicate.

The fix is not a better seal. It is to **anchor on the inputs the agent cannot author**, and to be honest about the line between *evidence* and *prevention*.

## The two unforgeable anchors

Everything trustworthy is built on these:

- **The transcript** — the harness's own record of what the agent did (tool calls, Bash command text, results). The agent can't author its own recorded actions. A Write/Edit to a referee file is detected from the *transcript* ledger (its changed path), excused only if the matching `/groundtruth-*` slash command — a user turn the agent can't forge — ratifies it.
- **The git-computed diff** of the real working tree (including untracked content), which the agent can't fake short of not writing the code. The Bash/MCP write channel — a referee file changed with no Write/Edit call — is caught by a SessionStart content-hash **snapshot** comparison: the write *effect*, read precisely, rather than a substring scan of the command stream.

## Evidence, not prevention — and scope the evidence too

Against an adversarial agent with shell access, Groundtruth **cannot prevent** a determined actor operating in its own trust domain. And the evidence is **not complete** either — the honest scope matters.

The transcript is an unforgeable *input*, but the sensor reading it (a `.claude/groundtruth/` path substring + a write-verb) is still an in-domain *classifier*. So it catches a **direct** write:

```
printf '{"block":false}' > .claude/groundtruth/config.json     # ⚠ surfaced
```

…but **not a laundered one**. Route the same effect through a one-line helper (`node launder.mjs` that flips `config.json` *and* re-forges the snapshot in the same breath) and the command sits in the transcript verbatim — **recorded but unrecognised** → a clean green over a disabled block. The hash snapshot, the supposed catch for "an effect laundered through a helper," also misses it, because the helper re-forged the snapshot.

| Config | Direct referee write | Laundered (helper re-forges snapshot) |
|---|---|---|
| **default** (no key) | ⚠ surfaced | 🟢 **evades — recorded, not surfaced** |
| key set, shell-readable | ⚠ surfaced | 🟢 evades (helper `printenv`s the key, signs a valid forgery) |
| **key set + held out of the shell's env** | ⚠ surfaced | ⚠ surfaced (helper can't sign → unsigned forgery is rejected) |

**In short: in-session tamper-evidence is reliable only with `GROUNDTRUTH_KEY` set AND held outside the agent's tool environment.** In the default config, a determined agent can keep its tamper out of the *verdict*, not just out of the block. The disk snapshot + signature are kept as defense-in-depth — they raise the cost and catch the naive cases — but they are **never trusted as state**. Chasing the laundered case with more in-session pattern-matching is the cat-and-mouse this design retired; the deterministic answer is a separate trust domain (see Hardening).

## What the multi-turn passes closed

Two later passes tightened the parts that *are* deterministically closable in-session:

- **Turn-scoped ratification.** A `/groundtruth-*` command invoked once no longer excuses a *later* out-of-band change (the covert re-disarm — arm rules, then `Bash echo '[]'` over them many turns on). The referee snapshot carries a *signed transcript high-water mark*, and only a ratifier invoked **since** it counts.
- **Signed per-target `observed` hash.** A ratifier excuses only a change made *this* turn, so a routine command — even a read-only `/groundtruth-rules list` — can't launder a tamper *held* from a prior turn into a green.

### Known residual

One in-session residual remains: **snapshot rollback-replay.** An older, validly-signed snapshot can be restored — HMAC proves authenticity, not recency. Like the laundered-helper row above, it is closed only by CI's fresh per-run snapshot. Mechanism and regression tests are in [FIXES.md](FIXES.md).

## Hardening for security-critical use

To upgrade *evidence → prevention*, the platform must provide what the hook cannot self-enforce:

1. **Hold `GROUNDTRUTH_BLOCK` / `GROUNDTRUTH_KEY` in an environment the agent's Bash tool cannot read** — otherwise `printenv` forges a valid signature.
2. **Keep the transcript unwritable by the agent.**
3. Ideally, **run the hook in a separate trust domain** — a pre-merge CI gate, not an in-session hook.

Under those conditions the env-anchored block is un-disablable and the transcript anchor is solid.

**Recommendation:** set `GROUNDTRUTH_BLOCK=1` and `GROUNDTRUTH_KEY=<random>` in an environment your agent's shell can't read, and treat the in-session hook as the **evidence** layer with a **CI / pre-merge run as the prevention layer**. `/groundtruth-block` (which writes `config.json`) is convenience for non-adversarial use only.

## Scope

This policy covers Groundtruth's own rails — its findings, its block loop, and the integrity of its verdict. It does not cover vulnerabilities in your project's code that Groundtruth reviews; those are for your own security process. Groundtruth's security checks (hardcoded secrets, RLS-off tables, committed `.env`) are heuristics that raise the floor, not a substitute for a dedicated scanner or audit.
