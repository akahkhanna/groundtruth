---
name: Feature request / new check
about: Propose a new finding class, rule, or behavior
title: "[feature] "
labels: enhancement
---

## The failure you want caught

<!-- Describe the real thing an agent does that slips through today. A transcript + diff that shows it is worth a thousand words. -->

## Can it be decided deterministically?

<!-- Groundtruth's per-turn engine is deterministic: no LLM, no network. Checks are regex / string / diff-structure. If your idea needs a model to judge intent (spec-substitution, "rationalised past a rule", regression detection), that's the roadmap semantic layer, not the per-turn engine — say so and it can still be tracked. -->

- [ ] I think this can be checked deterministically
- [ ] This probably needs the semantic/LLM layer

## Where must it NOT fire?

<!-- The abstain conditions. A check that false-fires is worse than no check. Where would a naive version of this wrongly flag correct code? -->

## Scope

<!-- Languages / file types this applies to. If it's only unambiguous in some (e.g. path-relative imports), note that it should abstain elsewhere. -->

## Anything else

<!-- Prior art, related findings, why existing checks don't cover it. -->
