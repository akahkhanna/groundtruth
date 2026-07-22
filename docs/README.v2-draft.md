<!-- DRAFT — v2.0.0 relaunch README. Not live. Replaces README.md only when GROUNDTRUTH_CONTRACT
     becomes the default (the prose layer retired). Until then the v1 README.md stands. -->

<h1 align="center">Groundtruth</h1>

<p align="center">
  <strong>Your agent signs its work. Groundtruth notarises it.</strong>
</p>

<p align="center">
  Every turn, your agent ends with a short signed manifest of what it did.<br>
  Groundtruth checks that manifest against the <code>git diff</code>, deterministically — line by line.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/deterministic-no%20LLM%20%C2%B7%20no%20network%20%C2%B7%20no%20API%20key-111111?style=flat-square" alt="Deterministic: no LLM, no network, no API key">
  <img src="https://img.shields.io/badge/runs%20on-Claude%20Code-111111?style=flat-square" alt="Runs on Claude Code">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

---

## The idea in one paragraph

v1 read the agent's English essay and *guessed* what it promised, then checked the guess against the code. Guessing from free prose is unbounded — you cannot enumerate a natural language with patterns, so every fix moved the failure to the next phrasing. **v2 inverts it.** The agent ends every turn with one small, fixed **claims block**. Groundtruth then does two bounded checks: everything on the manifest must exist in the diff, and everything in the diff must be on the manifest. Lying on the form is mechanically detectable; refusing to fill it in is itself the finding. You stop parsing an infinite language and start validating a grammar you wrote.

## The claims block

The agent ends a code-changing turn with one fenced block — JSON, so `JSON.parse` is the whole parser:

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

A closed set of eight claim types — `created` · `modified` · `deleted` · `renamed` · `tests_pass` · `build_pass` · `deferred` · `no_change`. `status` is `complete | partial | blocked`; `partial`/`blocked` must name what's outstanding with a `deferred` entry.

## The three findings

Groundtruth reads the block, then reality (the `git diff`, the transcript's command evidence, the added symbols), and renders one of three deterministic findings — or nothing:

| Finding | Means | The evasion it closes |
|---|---|---|
| **NC** — no contract | the block is missing, malformed, or schema-invalid | dodging the form entirely |
| **CA** — claimed but absent | a claim the diff/transcript don't support (a file that isn't there, a `tests_pass` that never ran or ran red, a symbol that isn't defined) | inventing work to look productive |
| **UC** — undeclared change | a changed file no claim covers | hiding sloppy work by omission |

The two directions form a **pincer**: omit a claim and `UC` fires; invent one and `CA` fires; dodge the form and `NC` fires; bury a lie in prose and it's *irrelevant*, because prose is no longer audited. The only honest path through is to declare exactly what you did — and have done it.

## What that buys over v1

- **`UC` is new.** v1 could only check what it managed to extract from prose. v2 audits the **whole diff** by construction — a file the agent quietly touched and didn't mention can't slip through.
- **`CA` is exact.** "claimed `src/upload.test.js`, absent from the diff" is a declared path compared to a diff, not a regex-guessed noun phrase. The false-positive treadmill of prose parsing is gone.
- **Precision is structural.** An honest, complete manifest produces zero findings — proven in the red-team acceptance pass, not asserted.

## What stays exactly as it was

Everything that reads the **diff** — the code-facing half — is unchanged, because code is a formal language and those checks were always sound: hardcoded secrets, RLS-off tables, committed `.env`, stub/placeholder markers, dropped-symbol dangling refs, test exclusion/weakening, compiled rules from your docs, and Rule Zero tamper-evidence. The claims contract replaces only the language-facing half.

## Abstain over guess

Unchanged charter, now structural: no transcript ⇒ test/build claims abstain; a file whose language can't be lexed ⇒ symbol claims abstain; excluded paths (lockfiles, generated) ⇒ no `UC`. **A false positive is fatal**, so every check that can't be decided from the reality it was given emits nothing rather than a wrong finding.

## Install

```
/plugin marketplace add akahkhanna/groundtruth
/plugin install groundtruth@groundtruth
```

Restart Claude Code, then run `/groundtruth-setup` — it writes the one-line contract instruction into your `CLAUDE.md` (inside Rule Zero's tamper perimeter, so an agent can't quietly edit it away). **Requires:** Claude Code, `node` ≥ 18, a git repo.

## Warn vs block

Default is **warn** — the verdict is recorded, the turn is never disrupted; build trust first. Opt into blocking with `/groundtruth-block on` once precision is proven on your sessions: a `CA` then refuses the stop and hands the gap back, capped at two attempts, then escalates to a human. Editing the tests / the checker / the ledger to satisfy a catch is flagged as gaming — the block holds.

## Docs

- **[Getting Started](../GETTING-STARTED.md)** · **[SECURITY.md](../SECURITY.md)** · **[CONTRIBUTING.md](../CONTRIBUTING.md)** · **[FIXES.md](../FIXES.md)** · **[ROADMAP.md](../ROADMAP.md)**

## License

[MIT](../LICENSE) © Akash Khanna
