# v2 prose-layer retirement — the deletion plan

**Status:** staged, held for soak. This is the "understand the tests before you delete them" map for physically removing the v1 prose layer once the claims contract is the default. Nothing here is cut yet — each stage below lands as its own commit with **green tests at every step** (never "delete the ones that fail").

## Principle

The contract replaces the **language-facing** half only. Every **code-facing** check (secrets, RLS, committed `.env`, stub/placeholder, dropped-symbol dangling refs, test exclusion/weakening on the diff, mojibake, compiled rules, Rule Zero tamper) **stays untouched** — code is a formal language and those were always sound. A function is on the kill list only if its *input* is English prose.

## What dies, and exactly what replaces it

### Subsystem A — prose CLAIM detection (feeds class 1 + class 3)
| Function | Engine site | Replaced by |
|---|---|---|
| `stripQuotedForClaim` (l.323) | `analyze()` class-1 scan (l.816), class-3 (l.359) | `CA` on `tests_pass`/`build_pass` (a *declared* cmd verified against transcript exit) and on `created`/`modified` (a *declared* path verified against the diff) |

v1 guessed "tests pass" / "I changed X" from prose; v2 has the agent **declare** `tests_pass`/`created`, and `verify()` checks it exactly. The whole quote-stripping / reported-speech / noun-`pass` FP apparatus becomes dead weight.

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

1. **Flip the default** — contract runs unless `GROUNDTRUTH_CONTRACT=0`. Update the 10 engine integration spawns that drive the Stop hook to emit a valid claims block (else they'd `NC`). Green.
2. **Cut the main() ledger wiring** (l.3232–3234) → feed the ledger from the contract's `deferred` claims. Remove the Task-ledger test section. Green.
3. **Cut subsystem A** — remove the class-1/3 prose scan from `analyze()` and `stripQuotedForClaim`; remove the Class-1 test section. Green.
4. **Delete the orphaned functions** (subsystem B) + prune their imports. Green.
5. **Demote to advisory** — `async_done`, `claimsSuccess`, completion/deferral stamps become an info-only footer (spec §7), not deleted.
6. **Swap the README** — `docs/README.v2-draft.md` → `README.md`; bump to `2.0.0`.

## Do NOT flip until

The contract has soaked on real sessions and precision is proven — because contract-default means **every session without a claims block gets `NC`** (a plain teammate session, or your own turns before `CLAUDE.md` lands). That is the enforcement trade this whole retirement rides on, and it is a product go/no-go, not a code step.
