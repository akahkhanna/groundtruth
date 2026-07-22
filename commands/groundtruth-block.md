---
description: "Turn Groundtruth BLOCK mode on/off (default: warn). No settings.json edit needed."
argument-hint: "on | off"
---

Set Groundtruth's block mode based on the argument: **$ARGUMENTS** (`on` or `off`; empty ⇒ just report the current value).

## `off` or empty
- **off** → read `.claude/groundtruth/config.json` (preserve any other keys), write `"block": false`, confirm.
- **empty** → report the current `block` value. Note if env `GROUNDTRUTH_BLOCK` is set — it overrides config (the un-disablable anchor).

## `on` — never flip silently; confirm what will START HALTING first
The rule is: **block must never enforce a predicate the user hasn't seen.** So before writing anything, show an itemized, evidence-backed picture, then require an explicit yes.

1. Read `.claude/groundtruth/compiled-rules.json` (the armed rules) and, if present, `.claude/groundtruth/history.jsonl` (the append-only per-turn log — each finding carries `cls`, `sev`, and, for a compiled rule, `rule` = its id).

2. **Compute per-rule fire counts** from history: tally findings by their `rule` id across all lines (older lines predating id-logging won't have it — count what's there and say the window is "since the log carried ids"). This is the evidence — reviewing *behavior* ("fired 14×, unarmed twice" vs "fired 0× in 6 weeks") is tractable where re-reading regexes is not. **Caveat the counts as advisory:** `history.jsonl` is gitignored and agent-writable (not integrity-snapshotted), so a count can be forged — it can't hide a rule (the *list* below comes from `compiled-rules.json`, which is authoritative), only misstate a number. So never let a low count *alone* justify enabling a block rule; the count informs, the itemized list decides.

3. Show the user what block actually changes — **be honest about the severity gate** (block only enforces findings that are already `block`-severity; it does NOT auto-promote your warn rules):
   - **Built-in block checks that will now HALT** (always, once block is on): hardcoded secret, committed `.env`, RLS-off / anon-permissive policy, and a **contract `CA`** (claimed-but-absent) — a claim the diff/transcript don't support: a `tests_pass`/`build_pass` that never ran or ran red, a `created`/`modified`/`deleted` file absent from the diff, or a claimed symbol not defined in the added code. These are code, not your rules — always block-severity. (`NC`/`UC` stay warn.)
   - **Your armed rules at `block` severity** — the rules that will start *refusing commits*. List each: `id` · message · **fired N×** · last-fired. Flag any with **0 fires or that the user hasn't visibly reviewed**: *"never fired / unreviewed — look before enabling."*
   - **Your armed rules at `warn` severity** — state plainly: these **stay warn and will NOT halt** under block mode. Optionally list the top few by fire count as promotion candidates (make one halt with `severity:"block"`).

4. **Ask for explicit confirmation:** *"Enable block? It halts on the built-in checks above and on `K` block-severity rule(s) [list them]. `M` warn rules stay warn. `[yes / review a rule / cancel]`."*
   - **review a rule** → show its text + fire count, offer to unarm it (`/groundtruth-rules unarm <id>`) or keep it, then re-ask. Never rubber-stamp a bare yes over an unreviewed block rule.
   - **yes** → only now write `config.json` `"block": true` (preserve other keys). **cancel** → write nothing.

5. Confirm: "Groundtruth block mode is now ON — effective next turn (the Stop hook re-reads config each run; no restart)." Remind: the un-disablable anchor is env `GROUNDTRUTH_BLOCK=1` in `settings.local.json`; `config.json` is agent-writable convenience, not a real boundary.

Context to relay: **block** = a *fixable* block-severity catch halts the stop with a corrective (retry cap → escalate, never wedges). **warn** = surfaced (card + badge) but never halts. Warn is the safe default; flip block once you trust the precision on your real sessions. Enabling block does **not** promote your warn rules — they stay warn until you set `severity:"block"`.
