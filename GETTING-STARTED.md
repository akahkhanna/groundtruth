# Getting started with Groundtruth

This walks you from zero to a working, trusted setup. Each stage unlocks the next — **you can stop at any stage and still get value.** The whole thing is a deterministic local hook: no model calls, no network, no API key.

## Prerequisites

- **Claude Code** (Groundtruth runs as a Claude Code plugin)
- **`node` ≥ 18**
- **A git repo** — reality is `git diff HEAD`, so the check only runs where there's a working tree to read

## 1. Install (once)

From inside Claude Code:

```
/plugin marketplace add akahkhanna/groundtruth
/plugin install groundtruth@groundtruth
```

Restart Claude Code so the hooks register. From here, **every agent turn already gets a warn-only verdict card** (honesty, completeness, security) — no further config.

Prefer to try it without installing?

```
git clone https://github.com/akahkhanna/groundtruth && claude --plugin-dir ./groundtruth
```

## 2. Confirm it's running

Finish any agent turn that touches code, then run:

```
/groundtruth
```

That prints the latest verdict card for the session. If you see a card, the hook is live. (In warn mode the card is written to `.claude/groundtruth/<session>.md`; `/groundtruth` always shows the most recent.)

## 3. See it on your existing code (optional)

```
/groundtruth-audit
```

A one-off inventory of the debt already in your repo — stubs, `TODO`/`FIXME`, phantom imports, plus any exposed `.env`. Findings, not a verdict. This is the cheapest way to watch Groundtruth work on code you know.

## 4. Arm your project rules

This is what turns on the **Told & Ignored** bucket — the check that catches a rule the agent *could see* and overrode anyway.

```
/groundtruth-rules-ai            # optional: a model pass proposing richer rules from your docs
/groundtruth-rules approve-all   # REQUIRED to enforce — arms every clean rule
```

On session start Groundtruth already read your docs (`CLAUDE.md`, `SCHEMA.md`, skills, …) and **proposed** deterministic rules from the lines you already marked as code (``use `X` not `Y` ``, ``never `Z` ``). Nothing arms until you approve:

- `approve-all` arms every *clean* rule (zero hits against existing code).
- `/groundtruth-rules` bare lets you review and name specific ids.
- If an armed rule ever fires wrongly, the card prints its `[id]` — silence it with `/groundtruth-rules unarm <id>`.

`/groundtruth-setup` will also arm the clean rules inline on a single yes — same thing, fewer steps.

## 5. Enforce, once you trust the precision

Default is **warn**: verdicts are recorded, turns are never disrupted. Build trust first. When precision is proven on *your* sessions:

```
/groundtruth-block on
```

(or set `GROUNDTRUTH_BLOCK=1` in `.claude/settings.local.json` — the un-disablable anchor.)

A block-severity finding then refuses the stop and hands the gap back, re-checking the fix for up to **2 attempts** before escalating to a human. It never wedges. Editing the tests, the checker, or the ledger to satisfy a catch is flagged as gaming — the block *holds* rather than releasing.

> **False positives are fatal.** Run in warn until precision is proven, *then* flip block. Every verdict carries file/line evidence, so a wrong call is auditable.

## Status badge (recommended)

The one manual settings line — a plugin can't set the main `statusLine` itself. Add to `.claude/settings.local.json`, pointing at the installed plugin's script:

```json
"statusLine": {
  "type": "command",
  "command": "node \"/absolute/path/to/groundtruth/hooks/groundtruth-statusline.mjs\""
}
```

It shows, every turn: `○ GT` (ran, no verdict yet) · `🟢 GT` (clean) · `🟡 GT·N` (N warnings) · `🔴 GT` (block) · `⏳ GT` (in progress). Without it, verdicts still write to disk and `/groundtruth` still prints them — you just lose the passive indicator.

## Updating

`/plugin marketplace update` refreshes the catalog cache but does **not** move the *installed* pin, and a restart reloads the old pin — so the verdict hook keeps running the stale engine, silently. Run:

```
/plugin update groundtruth
```

**and restart** so the new engine actually loads. Confirm `installed_plugins.json` shows the new version. The status badge surfaces this too: it shows `⬆<version>` when a newer version is cached but not yet pinned.

## Two ways to run outside the per-turn hook

- **Pre-commit** — `node hooks/groundtruth.mjs --install-pre-commit` wires a staged-diff scan (fail-open, won't clobber a foreign hook). Catches code pasted from a chat that no Stop hook ever saw.
- **CI / pre-merge** — `node hooks/groundtruth.mjs --diff-range origin/main..HEAD` exits non-zero on a block-severity finding. A ready GitHub Action ships at [`.github/workflows/groundtruth.yml`](.github/workflows/groundtruth.yml).

## Troubleshooting

- **No card after a turn?** Confirm you restarted Claude Code after install, and that you're in a git repo. Check `.claude/groundtruth/` for the session file.
- **A rule fired wrongly?** The card prints its `[id]` — `/groundtruth-rules unarm <id>`, and open an issue with the card output so precision can improve.
- **Nothing armed?** Rules never auto-arm. Run `/groundtruth-rules approve-all` (or `/groundtruth-setup`).

For what each check does and its honest scope, see the [README](README.md). For the adversarial trust model, see [SECURITY.md](SECURITY.md).
