---
description: "One-shot Groundtruth setup check — detects what's configured and hands you the exact actions for the rest."
---

You are running the Groundtruth setup check. Some things a Claude Code plugin **cannot set itself** — the main `statusLine` and any env var — so this command DETECTS the current state and gives the user the exact, copy-pasteable action for anything missing. Be concise: a 5-line checklist (✓ / ✗ + the one-line fix), then a one-line summary. This command is the **single point for rules** — the things it DOES execute, each only after the user says yes, are (a) arming clean literal rules **in warn** (item 1), (b) running the AI prose pass `/groundtruth-rules-ai` and arming its clean proposals (item 1, only when rule-docs exist), and (c) the `settings.local.json` badge/block wiring (the closing offer — it does NOT write an integrity key, item 4). Everything else you DETECT and hand back the fix; for `settings.local.json` edits SHOW the user the block to paste (it's their file). Never enable block mode or arm a `review`-status rule on your own.

First, resolve two paths you'll need:
- the **project root** = the cwd.
- the **plugin hooks dir**: find the newest `*/hooks/groundtruth-statusline.mjs` under `~/.claude/plugins/cache/groundtruth/groundtruth/` (use the highest version). Call it `<HOOKS>`. If you can't find it, fall back to telling the user to point at their groundtruth checkout's `hooks/`.

Then check each item and report `✓`/`✗`:

1. **Rules — arm the clean ones inline** (this command is the installer; don't punt to `/groundtruth-rules`). Read `.claude/groundtruth/proposed-rules.json` and `compiled-rules.json`. Count clean-proposed (`status:"armable"`, not already armed) vs any that `status:"review"` (already match committed code — over-broad risk).
   - If clean rules are unarmed → show the count and **ask before arming**: *"Found `N` clean rules extracted from your docs (they match zero existing code, so they can only fire on new code). Arm them **in warn** now? `[yes / review each / skip]`."* This is safe because arming in warn only adds a line to the verdict card — it never blocks — and each firing prints its `[id]` so you can `/groundtruth-rules unarm <id>` in one step. Warn ≠ enforce; block stays a separate, deliberate step (item 3).
     - **yes** → arm exactly the clean candidates: write `.claude/groundtruth/compiled-rules.json` as the union of already-approved + newly-approved, keeping only runtime fields (`id, source, kind, file_re, line_re, severity, message`, `unless_re` if present), `severity` defaulting to `"warn"`, preserving any existing rule's severity, deduped by `id`. (This write is legitimate — `/groundtruth-setup` is a ratified writer of compiled-rules.json, same as `/groundtruth-rules`.) Confirm: *"Armed N rules at warn — active next turn."*
     - **review each** → hand off to `/groundtruth-rules` (the ledger) for a rule-by-rule look; arm nothing here.
     - **skip** → arm nothing; note it stays available via `/groundtruth-rules approve-all` later.
   - Never arm a `status:"review"` candidate here — those match existing code and need a human eye in `/groundtruth-rules`. Surface their count as a heads-up.
   - If `proposed-rules.json` is missing, init hasn't run: say "start a fresh session, or run `node \"<HOOKS>/compile-rules.mjs\" .`".
   - **Richer rules from prose (`/groundtruth-rules-ai`) — this command is the single point, so OFFER TO RUN it here; gate the offer ONLY on whether rule-docs exist.** The deterministic extractor only catches rules written in the literal ``use `X` not `Y` `` / ``never `X` `` forms; rules written as prose sentences need the model pass. **Decide by doc PRESENCE, not by candidate count** (finding N literal rules does NOT mean every prose rule was caught — a doc-heavy repo with 26 literal hits can still have many prose rules the literal pass can't see):
     - Check for ANY rule-docs: `CLAUDE.md`, `AGENTS.md`, `**/SCHEMA.md`, `**/ARCHITECTURE.md`, `docs/*.md`, `.claude/skills/**/SKILL.md`, `.claude/agents/*.md`, `.cursorrules`, `.windsurfrules` (parity with the engine's `RULE_SRC_RE`).
     - **If there are NONE → do NOT offer the AI pass** (there is nothing for it to read; say so in one line and move on). *This is the only skip condition.*
     - **If any exist → OFFER to run it, regardless of how many literal rules were found. Say plainly what it does before running:** *"Your repo has prose rule-docs (`CLAUDE.md`, …) — the literal pass can't see rules written as sentences. Run the AI pass? It **fans out an agent ONCE, only to draft rule candidates** from those docs — the one and only place Groundtruth uses an LLM. It just **proposes**: nothing arms until you approve, and **after that no model is ever called again** — every per-turn audit stays fully deterministic + offline. `[yes / skip]`."* (This transparency is required — the user must know it's a one-time, propose-only agent pass, not ongoing LLM use.)
       - **yes** → invoke `/groundtruth-rules-ai` inline; when it returns proposals, arm the clean (`status:"armable"`) ones the SAME way as the literal candidates above (warn, review-status excluded). One flow — literal-arm + AI-propose + approve, all here; do not send the user to separate commands.
       - **skip** → note it stays available as `/groundtruth-rules-ai` later.

2. **Status badge** (recommended — in the VS Code extension, warn/clean verdicts only show via the badge). Read `.claude/settings.local.json` (and `settings.json`) for a `statusLine` key.
   - **Deploy the version-agnostic wrapper first** (do NOT pin the version dir — a path like `.../groundtruth/0.8.0/hooks/...` silently breaks the badge on the next plugin update). Copy the shipped wrapper to a STABLE path and make it executable:
     ```bash
     cp "<HOOKS>/groundtruth-statusline.sh" "$HOME/.claude/groundtruth-statusline.sh" && chmod +x "$HOME/.claude/groundtruth-statusline.sh"
     ```
     (The wrapper resolves the newest installed version at runtime, so the badge survives every update. It fails open — no install / no node → prints nothing.)
   - ✗ if `statusLine` is absent → give the EXACT block to paste into `.claude/settings.local.json`, with the user's real absolute home path filled in (Claude Code does not reliably expand `~`/`$HOME` in this command):
     ```json
     "statusLine": { "type": "command", "command": "bash \"/absolute/home/.claude/groundtruth-statusline.sh\"" }
     ```
     Note: only ONE statusLine can exist — if they already use one, this replaces it. If an OLD version-pinned `…/<version>/hooks/groundtruth-statusline.mjs` statusLine is already present, replace it with this wrapper form.

3. **Block mode** (default = warn, which is correct until you trust precision). Run `printenv GROUNDTRUTH_BLOCK` to detect the env anchor; also check `.claude/groundtruth/config.json` for `{block:true}`.
   - Report the live mode. To enable: **`/groundtruth-block on`** (convenience, agent-writable) OR add `"env": { "GROUNDTRUTH_BLOCK": "1" }` to `.claude/settings.local.json` (the **un-disablable** anchor — recommended for enforcement). Keep warn until you've watched it run clean on your real sessions; false positives are disruptive in block mode.

4. **Integrity key** (optional, security-critical only). Run `printenv GROUNDTRUTH_KEY` to detect.
   - **Where it belongs: CI, not here.** A `GROUNDTRUTH_KEY` written into `settings.local.json` is readable by the agent's own shell (`printenv`), so it only *raises the bar* — a determined agent can re-sign a forged snapshot. It is **evidence, not prevention**. Real tamper-prevention is a **CI/pre-merge gate**: a repo secret the CI job reads, in a trust domain the audited agent can't reach (the `--diff-range` mode + `.github/workflows/groundtruth.yml`). So this command does **not** write a local key — recommend a CI secret instead.
   - If a key IS already set locally, say so and name the trade-off: best-effort only, and a session whose integrity snapshot predates the key shows a benign *"signing not active this session — nothing was tampered"* info note (a ⚪ footer, not a warning, not injected into the next turn) each turn until you **restart** (SessionStart then re-snapshots under the key and signs it). To make it a real boundary, move it to a CI secret and drop it from `settings.local.json`.
   - Reminder: env vars for the hook live in `settings.local.json` (or the launching shell) — a project `.env` is the app's, NOT read by the hook — and `settings.local.json` must be gitignored; if it's tracked, `git rm --cached .claude/settings.local.json`.

5. **Pre-commit scan** (optional — the safety net for code an agent didn't author: a paste from a Claude *chat*, a hand-edit). The Stop hook only fires when Claude Code drives the edit; the git pre-commit hook fires on every `git commit` regardless, so it's the one place a manual paste gets checked. Check for a `.git/hooks/pre-commit` containing `groundtruth-pre-commit`.
   - ✗ if absent → **"run `node \"<HOOKS>/groundtruth.mjs\" --install-pre-commit` — scans the STAGED diff on every commit (secrets · RLS · stubs · dropped-symbol dangling refs). It's fail-open (never blocks on its own breakage), won't clobber a non-Groundtruth hook, and `git commit --no-verify` bypasses once. Re-run it after a plugin update if the path moves."**
   - If a foreign `pre-commit` already exists, `--install-pre-commit` refuses and prints the one line to add manually.

6. **v2 claims contract** (**ON by default** — opt out with `GROUNDTRUTH_CONTRACT=0`). Instead of parsing the agent's prose, the agent ends each turn with one fenced `groundtruth-claims` block declaring exactly what it did; Groundtruth then checks that every claim exists in the diff (**CA** — claimed but absent) and every change it authored is declared (**UC** — undeclared change). A turn that authored changes but emits no block is **NC** (no contract); a pure Q&A/read-only turn abstains. Detect config with `printenv GROUNDTRUTH_CONTRACT`, and grep `CLAUDE.md` for a ` ```groundtruth-claims ` instruction.
   - The engine is already on. The **one thing to set up** is teaching the agent the schema: an instruction in `CLAUDE.md` telling it to emit the block (otherwise every change-bearing turn is NC). It never *blocks* unless `GROUNDTRUTH_BLOCK` is also on and a CA fires. To disable the contract entirely, set `env.GROUNDTRUTH_CONTRACT = "0"` in `.claude/settings.local.json`.
   - **Offer to append the contract instruction to `CLAUDE.md`** (their file — show it first, write on yes):
     ````
     ## Groundtruth claims contract
     End every turn that changes code with ONE fenced block declaring what you did:
     ```groundtruth-claims
     { "v": 1, "task": "<one line>", "status": "complete|partial|blocked",
       "claims": [ { "t": "created|modified|deleted|renamed|tests_pass|build_pass|deferred|no_change", "...": "..." } ] }
     ```
     Every claim must be true against the diff; declare every file you changed; status partial/blocked needs a `deferred` claim.
     ````
     Once the instruction is in `CLAUDE.md` the session is **contract-aware**: an omitted manifest on a code turn becomes block-eligible. Awareness is anchored on the **session baseline** (not the live worktree), so an agent can't strip the instruction mid-turn to downgrade the block — the strip is surfaced as its own finding. The contract is the **default engine** as of v2.0.0 (opt out with `GROUNDTRUTH_CONTRACT=0`); it runs in **warn** until you turn block on, so keep block off while you watch its precision on your real turns.

End with one summary line, e.g.: `Setup → rules: N clean unarmed (arm in warn?) · badge: ✗ · block: warn (on = enforce) · key: off (CI = real enforcement) · pre-commit: ✗ install · contract: on (default; instruction written).` (after arming: `rules: armed N (warn)`).

Then **offer to do the `settings.local.json` parts yourself** (the user asked for this): *"Want me to set up `settings.local.json` now — deploy the status badge, and (optional) turn on block mode? I will NOT write a `GROUNDTRUTH_KEY` here — that belongs in a CI secret (item 4), where it's actually out of my reach."* If they say yes:
1. Deploy the status-line wrapper (`cp "<HOOKS>/groundtruth-statusline.sh" "$HOME/.claude/groundtruth-statusline.sh" && chmod +x` it). Then read `.claude/settings.local.json` (create `{}` if absent), and **merge** (preserve existing keys): add the `statusLine` block pointing at the wrapper with the user's real absolute home path filled in (`bash "/abs/home/.claude/groundtruth-statusline.sh"`). If an old version-pinned statusLine exists, replace it. Write valid JSON.
2. **Only if the user explicitly asks for block** (default is warn — ask, don't assume): add `env.GROUNDTRUTH_BLOCK = "1"` (the un-disablable anchor). **Never** write `env.GROUNDTRUTH_KEY` — a shell-readable key is best-effort, not prevention (item 4). If they want real integrity, point them to a **CI secret** + the `--diff-range` workflow, not this file.
3. If `.claude/settings.local.json` is git-tracked (`git ls-files --error-unmatch` succeeds), run `git rm --cached .claude/settings.local.json` so nothing local leaks, and confirm it matches a `.gitignore` rule.
4. Tell them the env (if block was added) takes effect on the next session (the hook reads it at launch), and the badge after a Claude Code restart. The block flag IS solid (the agent can read it but can't change what the hook sees); the removed key was not.
