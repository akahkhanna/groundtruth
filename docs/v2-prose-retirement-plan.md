# v2 prose-layer retirement — the deletion plan

**Status:** staged, held for soak. This is the "understand the tests before you delete them" map for physically removing the v1 prose layer once the claims contract is the default. Nothing here is cut yet — each stage below lands as its own commit with **green tests at every step** (never "delete the ones that fail").

## Principle

The contract replaces the **language-facing** half only. Every **code-facing** check (secrets, RLS, committed `.env`, stub/placeholder, dropped-symbol dangling refs, test exclusion/weakening on the diff, mojibake, compiled rules, Rule Zero tamper) **stays untouched** — code is a formal language and those were always sound. A function is on the kill list only if its *input* is English prose.

## What dies, and exactly what replaces it

### Subsystem A — prose CLAIM detection (feeds class 1 + class 3)
| Function | Engine site | Replaced by |
|---|---|---|
| `stripQuotedForClaim` (l.323) | `analyze()` class-1 scan (l.816), class-3 (l.359) | `CA` on `tests_pass`/`build_pass` (a *declared* cmd verified against transcript exit) and on `created`/`modified` (a *declared* path verified against the diff) |

v1 guessed "tests pass" / "I changed X" from prose; v2 has the agent **declare** `tests_pass`/`created`, and `verify()` checks it exactly.

> **⚠ Stage-3 findings (discovered while executing — NOT a mechanical cut; needs a decision).**
> 1. **The kill list contradicts itself.** `claimsSuccess` — which the spec KEEPS (advisory) and which gates the three test-gaming checks that stay (`l.370`/`415`/`720`: test-exclusion, test-weakening, vacuous-test) — itself calls `stripQuotedForClaim`. So `stripQuotedForClaim` cannot die while `claimsSuccess` lives. Either keep both, or rewrite `claimsSuccess` off it.
> 2. **`CA` is a capability regression vs class-1.** The prose class-1 scan uniquely catches **stale-green** (`l.1141`: a green that predates the last source edit), **filtered-subset** (`l.1142`: "all pass" but every run was `--grep`'d), and **only-weak** (`l.1134`: only `tsc`/`node --check` ran). The contract's `tests_pass` check only asks "did that cmd run green?" — deleting class-1 drops those three sensors.
>
> **Decision needed before Stage 3 runs** — one of:
> - **A) Accept the loss** — delete the class-1 prose scan + class-3; keep `claimsSuccess`+`stripQuotedForClaim` for the test-gaming checks. Simplest; `tests_pass` becomes a cruder check.
> - **B) Port the sensors** — move stale-green / filtered / only-weak into the contract's `tests_pass` verification (thread mutation timestamps + run ordering into `reality`). Keeps capability; more work.
> - **C) Keep class-1** — leave it firing on prose claims. Contradicts "prose isn't audited" and double-fires with `CA`.

### Subsystem B — prose INTENT / task ledger (feeds open-loop / deferred / Tasks)
| Function | Engine site | Replaced by |
|---|---|---|
| `openLoops` (l.1788) | ledger build | contract `task` + `deferred` |
| `extractTokens` (l.1903) | `classifyDeliverables` | — |
| `splitClauses` (l.1915) | `classifyDeliverables` | — |
| `pasteStripped` (l.1926) | `classifyDeliverables` | — |
| `dePassive` / `deNoun` (in `classifyDeliverables`, l.1996) | `classifyDeliverables` | — |
| `classifyDeliverables` (l.1950) | `namedDeliverables`, `updateTaskLedger` | contract declarations |
| `namedDeliverables` (l.2048) | — | — |
| `updateTaskLedger` (l.2058) | `main()` l.3232 | ledger fed by the block's `deferred` entries (spec §6) |
| `claimClosesToken` (l.2119) | `surfaceOpenLoop` | a later turn's `created`/`modified` claim closing the deferral |
| `surfaceOpenLoop` (l.2135) | `main()` l.3234 | — |

Per spec §6: v2 **replaces extraction with declaration** — the ledger is fed by the block's `task` restatement + `deferred` items, and a deferral stays open until a later turn *claims* it. Whether the `task` restatement matches what the human asked is a human reading the card (a semantic judgment regex was never allowed to make). `humanDeferrals` / slash-command ratification **stay** — they key off transcript structure, not prose.

## Test sections to remove (understood, not "delete-what-fails")

| Test block | Lines | Why it goes |
|---|---|---|
| Class 1 (false test/build claim) + all C1 precision/adversarial/artifact subsections | 67–427 | tests prose "tests pass" detection → replaced by `CA` on `tests_pass` |
| Task ledger + ledger self-healing | 1649–~2260 | tests `classifyDeliverables`/`updateTaskLedger`/`surfaceOpenLoop` prose extraction → replaced by declared `deferred` |
| The dying names in the `import { … }` line (l.14) | 14 | `stripQuotedForClaim`, `classifyDeliverables`, `openLoops`, `updateTaskLedger`, `surfaceOpenLoop`, plus `claimsSuccess` (already advisory) |

The v2 replacement coverage already exists: `claims-contract.test.mjs` (87 checks) + red-team Scenario K (the evasion table, live). Those become the honesty/completeness regression set.

## Staged order (each stage = one green commit)

1. ✅ **Flip the default** — contract runs unless `GROUNDTRUTH_CONTRACT=0`. *(Done — no test breakage; suite drives `analyze()` directly, spawns tolerate the added `NC`.)*
2. ✅ **Cut the main() ledger wiring** → declared `deferred` claims surface instead; `tasks.json` retired; redteam scenario E ported to `CA`. *(Done — 762+88, redteam 20/20.)*
3. ⏸ **Cut subsystem A** (class 1/3 prose) — **BLOCKED on the Stage-3 decision above** (the `claimsSuccess`/`stripQuotedForClaim` entanglement + the stale-green/filtered/only-weak capability loss). Not a mechanical cut.
4. **Delete the orphaned subsystem-B functions** (`openLoops`, `classifyDeliverables`, `splitClauses`, `extractTokens`, `pasteStripped`, `updateTaskLedger`, `claimClosesToken`, `surfaceOpenLoop`, `namedDeliverables`) + prune their imports and the Task-ledger test section (`l.1649–2260`). These are now unreferenced by `main()`; safe to delete once confirmed nothing else calls them.
5. **Demote to advisory** — `async_done`, `claimsSuccess`, completion/deferral stamps become an info-only footer (spec §7), not deleted.
6. **Swap the README** — `docs/README.v2-draft.md` → `README.md`; bump to `2.0.0`.

**Progress: stages 1, 2, 4 DONE and green (engine 3331 → 2950). Stage 3 is the last piece — designed below.**

## Stage 3 — the design (decided: PORT the 3 sensors)

Couples the sensor-port with removing class-1/3 prose (they'd double-fire otherwise). Do it as one commit.

**3a — port the sensors into the contract `tests_pass` check (`claims-contract.mjs`).** Enrich `reality`:
- `commands: [{ cmd, ok, seq }]` — add `seq` from `bashEvents.seq`.
- `lastEditSeq` — max `seq` of code mutations, from `parsed.mutations` (thread it through `buildReality`).

Then in `verify()`'s `tests_pass`/`build_pass` branch, after the matched-green-run check, add three warn-tier findings (patterns lifted verbatim from the current engine so there's no drift):
- **only-weak** — `WEAK_CHECK_RE` (engine l.886: `node --check|tsc|deno check|cargo check|go vet|py_compile|ruby -c`) tests the DECLARED `cmd` → "that's a type/syntax check, not a test run."
- **filtered** — every matched green run's cmd is filtered (`GENERIC_FILTER_RE` l.1095 `--grep|--test-name-pattern` + `RUNNER_FILTERS` l.1096 `pytest -k`, `dotnet --filter`, …) → "a filtered run can't back the claim."
- **stale-green** — the matched green run's `seq < reality.lastEditSeq` → "the green predates the last source edit."

Abstain when `seq`/`lastEditSeq` absent (pre-commit / no transcript), same contract as everywhere.

**3b — remove the class-1 prose scan** (`analyze()` `_passClaim` block, ~l.863–1155) — the "tests pass" prose detection. KEEP `claimsSuccess` + `stripQuotedForClaim` (they gate the test-exclusion/weakening/vacuous checks that stay). KEEP the `testFiles`-only class-1 (l.1152, "only tests changed") if it doesn't depend on `_passClaim`.

**3c — remove the class-3 prose block** (`analyze()`, ~l.1196–1237). Then `NONREPO_OR_TOOL` (restored in stage 4) becomes unused → delete it too.

**3d — prune tests**: the Class-1 section (`groundtruth.test.mjs` l.67–427) + the class-3 no-op tests. Add contract sensor tests (weak/filtered/stale) to `claims-contract.test.mjs`. Coverage moves to the contract suite + red-team Scenario K.

## Do NOT flip until

The contract has soaked on real sessions and precision is proven — because contract-default means **every session without a claims block gets `NC`** (a plain teammate session, or your own turns before `CLAUDE.md` lands). That is the enforcement trade this whole retirement rides on, and it is a product go/no-go, not a code step.
