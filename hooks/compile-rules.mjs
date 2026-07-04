#!/usr/bin/env node
// Self-validating rule compiler — the "find deterministic rules from your docs" step.
//
// THREE halves, all honest:
//   1. EXTRACT (this file, no LLM) — read the project's declared rule docs and pull candidate rules out
//      of the unambiguous prose forms the author already marked as code with backticks:
//        • corrective pair:  `correct` (not `wrong`)  OR  `correct` not `wrong`   → forbid `wrong`
//          (the no-paren form is how many docs state gotchas — e.g. `users.created_at` not `signup_date` —
//           and the original regex required the parens, so every no-paren rule was silently missed.)
//        • explicit forbid:  never `wrong` / do not use `wrong`                    → forbid `wrong`
//      The scan covers EVERY rule source, not just CLAUDE/SCHEMA: CLAUDE/AGENTS/SCHEMA/ARCHITECTURE,
//      docs/*.md, every .claude/skills/**/SKILL.md, every .claude/agents/*.md, .cursor/.windsurf rules.
//      (File-SCOPED rules can't be derived from prose — a directory/filename scope lives nowhere in
//      the sentence — so a repo supplies those itself in .claude/groundtruth/seed-rules.json. Nothing
//      project-specific is hardcoded in this plugin; it only reads YOUR docs + YOUR seed file.)
//   2. GROUND (the reusable guarantee) — grep each candidate against the actual tree. A pattern that
//      already matches committed code is either a real existing bug OR an over-broad rule, so it's
//      marked 'review', never auto-cleared. Clean candidates (0 code hits) are marked 'armable'.
//   3. PROPOSE, don't arm (the permission gate) — write every candidate to proposed-rules.json with its
//      status. NOTHING is enforced until a human approves it via `/groundtruth-rules`, which is the step
//      that writes the active compiled-rules.json. Broadening the extractor is only safe because of this
//      gate: over-collection lands in the review pile for a human to reject, it never auto-fires.
//
//   usage: node hooks/compile-rules.mjs [repo-root]
import { execFileSync } from 'node:child_process';   // execFile (no shell) — the doc pattern has backticks
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';            // run-as-main guard must be cross-platform (see bottom)
import { compileRuleRe } from './groundtruth.mjs';   // SAME regex normalizer the runtime uses (grounder⇄runtime parity)

// Every declared rule source (matches groundtruth.mjs RULE_SRC_RE — the --watch-rules trigger).
const RULE_PATHSPECS = [
  ':(glob)**/CLAUDE.md', ':(glob)**/AGENTS.md', ':(glob)**/SCHEMA.md', ':(glob)**/ARCHITECTURE.md',
  ':(glob)**/docs/*.md', ':(glob)**/.claude/skills/**/SKILL.md', ':(glob)**/.claude/agents/*.md',
  '.cursorrules', '.windsurfrules',
];

// Source extensions a doc-extracted rule can scope to. The rule's file_re is derived from the languages
// ACTUALLY PRESENT in the repo — not hardcoded to JS (which made every extracted rule inert on a Python/
// Go/Rust repo, AND made grounding blind so over-broad rules falsely passed as 'armable'), and not every
// conceivable extension (which would fire a JS-derived rule on a language the repo doesn't even contain).
// sql is always in scope: many doc gotchas are schema/column names.
const SOURCE_EXTS = ['js','ts','mjs','cjs','jsx','tsx','py','go','rs','rb','java','kt','kts','c','cc','cpp','cxx','h','hpp','cs','php','swift','scala','sh','bash','m','mm','vue','svelte','ex','exs','clj','cljs','lua','dart','sql'];
function gitLsFiles(root) {
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}
// Extensions present in this repo ∩ the known source set → the per-repo rule scope. Empty/unknown repo
// (or no git) → broad default so a rule still has SOME scope. Exported for the self-check.
export function repoSourceExts(root, ls = gitLsFiles) {
  const present = new Set();
  for (const f of ls(root).split('\n')) {
    const ext = (f.match(/\.([A-Za-z0-9]+)$/) || [])[1];
    if (ext && SOURCE_EXTS.includes(ext.toLowerCase())) present.add(ext.toLowerCase());
  }
  return present.size ? [...present] : SOURCE_EXTS;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A `wrong` token is only safe to forbid if it reads like a real identifier: starts with a letter,
// ≥3 chars. Drops partials/abbreviations like `_API_KEY` (leading underscore) that would mis-anchor.
export function isArmableToken(t) { return /^[A-Za-z][\w.]{2,}$/.test(t); }

// Pure: pull every corrective pair out of one line of prose. A line may carry several.
// Matches BOTH `correct` (not `wrong`) and `correct` not `wrong` — the [^`\n]{0,8} between the
// closing backtick and "not" absorbs " (", ", ", " is " etc. but the no-backtick class can't leap
// over a third token, so `a` and `b` are not `c` correctly pairs b→c, never a→c.
export function parseCorrectivePairs(text) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`]+)`[^`\n]{0,8}?\bnot\s+`([^`]+)`/gi))
    out.push({ correct: m[1], wrong: m[2] });
  return out;
}

// Pure: pull every explicit "never `wrong`" / "do not use `wrong`" out of one line. No `correct`
// alternative is offered, so the message just says "avoid". Requires the backtick token to sit right
// after the directive (+ an optional use/introduce/add) so "never going to `x`" does NOT match.
export function parseForbidTokens(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(?:never|do not|don['’]?t)\s+(?:use\s+|introduce\s+|add\s+|re-?introduce\s+)?`([^`]+)`/gi))
    out.push({ wrong: m[1] });
  return out;
}

// Default doc grep — corrective-pair form across all rule sources. Returns `path:line:content` rows.
// execFileSync (not a shell string): the pattern contains backticks, which a shell would treat as
// command substitution and silently corrupt the regex (the bug that armed 0 extracted rules).
function gitGrep(root, pattern, pathspecs) {
  try {
    return execFileSync('git', ['grep', '-nI', '-E', pattern, '--', ...pathspecs],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }   // git grep exits 1 on no match
}

// Read the docs → candidate forbid_in_added rules, with provenance. grep is injectable for testing.
// Two passes over all rule sources: corrective pairs (`X` not `Y`) and explicit forbids (never `X`).
export function extractCandidates(root, grep = gitGrep, ls = gitLsFiles) {
  const cands = [], seen = new Set();
  const file_re = '\\.(' + repoSourceExts(root, ls).join('|') + ')$';   // scoped to the repo's own languages
  const add = (file, lineno, correct, wrong) => {
    if (!isArmableToken(wrong)) return;
    const line_re = '\\b' + escapeRe(wrong) + '\\b';
    const key = file_re + '|' + line_re;
    if (seen.has(key)) return;
    seen.add(key);
    cands.push({ id: 'no-' + wrong.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      source: `extracted from ${file}:${lineno}`, kind: 'forbid_in_added',
      file_re, line_re, severity: 'warn', positive_example: wrong,   // the forbidden token — line_re must match it (fire-proof)
      message: correct ? `use \`${correct}\`, not \`${wrong}\`` : `avoid \`${wrong}\` (forbidden by ${file})` });
  };
  const rows = (raw) => raw.split('\n').filter(Boolean)
    .map(ln => ln.match(/^(.*?):(\d+):(.*)$/)).filter(Boolean);   // [, path, line, content] — paths have no ':'

  // corrective pairs — loose grep finds candidate lines, parseCorrectivePairs is the real filter.
  for (const [, file, lineno, content] of rows(grep(root, '`[^`]+`[^`]{0,8}not `[^`]+`', RULE_PATHSPECS)))
    for (const { correct, wrong } of parseCorrectivePairs(content)) add(file, lineno, correct, wrong);
  // explicit forbids — never `X` / do not use `X`.
  for (const [, file, lineno, content] of rows(grep(root, '(never|do not|don.t)[^`]{0,14}`[^`]+`', RULE_PATHSPECS)))
    for (const { wrong } of parseForbidTokens(content)) add(file, lineno, null, wrong);
  return cands;
}

// File-SCOPED rules the prose form can't express (the scope — a directory or filename — isn't in the
// doc sentence). These are PER-PROJECT and NOT shipped with the plugin: a repo that wants them drops a
// JSON array of rule objects at .claude/groundtruth/seed-rules.json, and they're merged in + grounded
// through the SAME gate as extracted ones. Nothing here is hardcoded to any one codebase.
// Shape (each entry): { id, kind:'forbid_in_added'|'forbid_path', file_re, line_re?, unless_re?, message }
function loadSeeds(root) {
  try {
    const j = JSON.parse(readFileSync(join(root, '.claude', 'groundtruth', 'seed-rules.json'), 'utf8'));
    return (Array.isArray(j) ? j : []).filter(r => r && r.id && r.file_re)
      .map(r => ({ severity: 'warn', source: 'seed-rules.json (per-project, file-scoped)', ...r }));
  } catch { return []; }   // absent / malformed → no seeds, never crashes
}

// Ground a candidate: how many committed code lines already match its predicate. MUST agree with the
// runtime evaluator (runCompiledRules uses JS `new RegExp` where `\b` works), so it greps with -P
// (PCRE) — `git grep -E` SILENTLY IGNORES `\b`, which made every `\b`-wrapped extracted rule report 0
// hits and pass grounding even when it matched code everywhere (e.g. `\bmap\b`). Falls back to ERE on a
// `\b`-stripped (superset → errs toward 'review') pattern only if this git lacks PCRE.
function codeHits(root, line_re, file_re) {
  // Grep a BROAD superset of source globs (so a non-JS repo's files are actually searched — the old
  // JS/SQL-only globs made grounding blind on Python/Go/Rust); the precise per-rule scoping is the
  // file_re post-filter below, so the glob just must not MISS a file the file_re would have matched.
  const files = SOURCE_EXTS.map(e => '*.' + e);
  const grep = (flag, pat) => execFileSync('git', ['grep', '-nI', flag, pat, '--', ...files],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let out;
  try { out = grep('-P', line_re); }                          // honours \b exactly like the runtime
  catch (e) {
    if (e.status === 1) return [];                            // exit 1 = clean (no match)
    try { out = grep('-E', line_re.replace(/\\b/g, '')); }    // no PCRE → ERE on \b-stripped superset
    catch (e2) { return []; }                                 // exit 1 (or unusable) → treat as clean
  }
  return out.split('\n').filter(Boolean).filter(h => new RegExp(file_re).test(h.split(':')[0]));
}

// A `forbid_path` rule has NO line_re — it forbids a FILE existing at a path (e.g. `^api/.*\.mjs$`). Its
// grounding must test file_re against the tracked-file LIST, not grep content. Without this, codeHits was
// called with line_re=undefined → threw → caught → [] → the rule ALWAYS grounded 'armable', even when a
// matching file was already committed (an over-broad path rule looked safe). Now: a committed match → 'review'.
function pathHits(root, file_re, ls = gitLsFiles) {
  // compileRuleRe (NOT `new RegExp(file_re,'i')`) — the same normalizer the runtime + the grounder's JS-compile
  // gate use, so a `(?i)`-prefixed file_re doesn't throw here and vacuously ground 'armable' (the very hole this
  // path-grounding closes) while passing everywhere else. Parity with runCompiledRules' file_re evaluation.
  try { const re = compileRuleRe(file_re); return ls(root).split('\n').filter(Boolean).filter(f => re.test(f)); }
  catch { return []; }   // bad file_re → no hits (the JS-compile gate in compile() already routes it to review)
}

// Compile docs → proposed-rules.json. Pure-ish (codeHits/pathHits/grep injectable) so the test can drive it.
export function compile(ROOT, { code = codeHits, paths = pathHits, grep } = {}) {
  // extracted first (real provenance wins), then the project's own file-scoped seeds; dedup by predicate.
  const merged = [], seen = new Set();
  for (const c of [...extractCandidates(ROOT, grep), ...loadSeeds(ROOT)]) {
    const key = c.file_re + '|' + c.line_re;
    if (seen.has(key)) continue;
    seen.add(key); merged.push(c);
  }
  // Validate + ground each. Two deterministic gates run BEFORE grounding — both routed to 'review' (never
  // auto-armed), so a broken or non-firing candidate can't slip through `approve-all`:
  //  (1) RUNTIME-PARITY: the regex must compile in JS via compileRuleRe — the exact normalizer the runtime
  //      uses. The grounder greps with PCRE (`git grep -P`), which accepts patterns JS rejects, so without
  //      this a PCRE-valid rule (e.g. a hand/LLM-authored one) could ground 'armable' yet be inert at runtime.
  //  (2) FIRE-PROOF: if the candidate ships a positive_example, line_re MUST match it. Grounding only proves
  //      the rule doesn't hit EXISTING code (over-broad); it never proves the rule CAN fire. The example does.
  // Then ground: 0 code hits → 'armable' (safe), already-in-code → 'review' (real bug or over-broad).
  return merged.map(c => {
    let jsErr = null;
    try { compileRuleRe(c.file_re); if (c.line_re) compileRuleRe(c.line_re); if (c.unless_re) compileRuleRe(c.unless_re); }
    catch (e) { jsErr = e.message; }
    if (jsErr) return { ...c, status: 'review', reason: `regex does not compile at runtime (JS): ${jsErr}` };
    if (c.positive_example != null && c.line_re && !compileRuleRe(c.line_re).test(String(c.positive_example)))
      return { ...c, status: 'review', reason: 'line_re does not match its positive_example — the rule may never fire' };
    const hits = (c.kind === 'forbid_path' || !c.line_re) ? paths(ROOT, c.file_re) : code(ROOT, c.line_re, c.file_re);
    return hits.length === 0
      ? { ...c, status: 'armable' }
      : { ...c, status: 'review', hits: hits.length, sample: hits[0].slice(0, 120) };
  });
}

function main() {
  const ROOT = process.argv[2] || process.cwd();
  const proposed = compile(ROOT);

  const dir = join(ROOT, '.claude', 'groundtruth');
  mkdirSync(dir, { recursive: true });
  // PROPOSE — never arm. The active set (compiled-rules.json) is written ONLY by /groundtruth-rules
  // after a human approves, so nothing here can enforce on its own. Re-running is safe + idempotent:
  // it refreshes the candidate list; it never touches the approved set or its block-promotions.
  writeFileSync(join(dir, 'proposed-rules.json'), JSON.stringify(proposed, null, 2) + '\n');

  const armable = proposed.filter(p => p.status === 'armable');
  const review = proposed.filter(p => p.status === 'review');
  console.log(`PROPOSED ${proposed.length} rules from your docs → .claude/groundtruth/proposed-rules.json (run /groundtruth-rules to review + approve — nothing is enforced until you do)`);
  console.log(`\n  ${armable.length} clean (0 existing code hits → safe to approve):`);
  armable.forEach(r => console.log(`  ✓ ${r.id} — ${r.message}  [${r.source}]`));
  console.log(`\n  ${review.length} need review (matches committed code, won't compile, or fails its example):`);
  review.forEach(r => console.log(r.reason
    ? `  ⚠ ${r.id} — ${r.reason}`
    : `  ⚠ ${r.id} (${r.hits} code hits) — e.g. ` + r.sample));
}

// Run-as-main guard: `file://${argv[1]}` is WINDOWS-BROKEN — import.meta.url is `file:///C:/...` (forward
// slashes) but argv[1] is `C:\...` (backslashes), so they never match and main() never runs → recompileRules
// (which shells out here) silently writes no proposed-rules.json, killing the rules feature on Windows.
// pathToFileURL normalizes both and resolves a relative argv too. Same class as the C6 grep-quoting fix.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
