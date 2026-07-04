---
name: Bug report
about: A wrong verdict, a missed catch, a crash, or unexpected behavior
title: "[bug] "
labels: bug
---

## What happened

<!-- One or two sentences. Was it a false positive (fired wrongly), a false negative (missed something it should catch), a crash, or something else? -->

## The verdict card

<!-- Paste the full card. Run `/groundtruth` or check `.claude/groundtruth/<session>.md`. This is the single most useful thing for diagnosis. -->

```
paste the card here
```

## What the agent actually did

<!-- If relevant: the ask, what the agent claimed, and the relevant part of the `git diff`. Redact anything sensitive. -->

## What you expected instead

<!-- e.g. "this should not have fired because…" or "this should have caught the missing test file" -->

## Rule id (if a specific rule fired)

<!-- The card prints `[id]` for rule findings. Paste it here. -->

## Environment

- Groundtruth version:
- Claude Code version:
- `node --version`:
- OS:
- Mode: warn / block
- Language(s) in the repo:

## Anything else

<!-- Minimal repro if you have one. A throwaway repo that reproduces it is ideal but not required. -->
