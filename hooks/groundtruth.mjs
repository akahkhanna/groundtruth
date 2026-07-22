#!/usr/bin/env node
/**
 * groundtruth.mjs — Groundtruth Tier-1, a Claude Code `Stop` hook (registered in the
 * repo-root .claude/settings.local.json).
 *
 * Audits the just-finished turn artifact-against-contract and renders a verdict
 * card. ALL checks are deterministic — no LLM, no network, no agent hook:
 *   honesty    1 false test/build claim · 2 stub/placeholder · 3 silent no-op · 4 phantom ref · 6 dropped symbol (dangling ref) · 9 special-casing
 *   complete.  5 scope-miss — a named deliverable absent from the diff (open-loop / task ledger)
 *   rules      7 directive-override — your docs compiled into deterministic predicates + enforced
 *   security   hardcoded secrets · RLS-off / anon-readable policy · committed .env
 * The semantic layer (richer ask↔delivery matching, spec-substitution) is roadmap, not shipped.
 *
 * Sources of truth — no persisted ledgers needed:
 *   Claim   = payload.last_assistant_message (free from the Stop payload)
 *   Intent  = first non-sidechain user message in the transcript JSONL
 *   Evidence= Bash tool_use + tool_result entries in the transcript
 *   Reality = `git diff HEAD`
 *
 * Default WARN: surface the card to the user in-window via the JSON `systemMessage`
 * channel (plain Stop-hook stdout is debug-only) AND persist it to
 * .claude/groundtruth/<session>.md, exit 0. BLOCK is opt-in: with GROUNDTRUTH_BLOCK=1, a block-severity finding
 * emits {"decision":"block","reason":...} so Claude finishes the gap before
 * stopping. Fail-OPEN on any infrastructure error — a hiccup never wedges the harness.
 *
 * Pure `analyze()` + `parseTranscript()` are exported for groundtruth.test.mjs.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, chmodSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';   // to suppress the live editor-pop for throwaway repos (redteam/tests) + CI
import { fileURLToPath } from 'node:url';   // NOT `new URL(...).pathname` — that percent-encodes spaces (`john doe`→`john%20doe`), silently inerting every path-derived check on a spaced/Windows/cloud-synced install
// Class 6 lives in its own module (this engine is already large). The import is a deliberate cycle
// (symbol-integrity.mjs re-imports the pure lexers below) — safe because every cross-reference is at
// call time, never at module-eval time.
import { checkDroppedSymbols, addedSymbolsByFile } from './symbol-integrity.mjs';
// v2 claims contract (opt-in, GROUNDTRUTH_CONTRACT=1). Pure module — parse + validate + verify the agent's
// end-of-turn claims block against reality. Off by default; v1 is the fallback during soak.
import { buildReality, contractFindings, analyze as analyzeContract, openDeferrals } from './claims-contract.mjs';

const CLASS_NAME = { 1: 'false test/build claim', 2: 'stub/placeholder', 3: 'silent no-op', 4: 'phantom ref',
  6: 'dropped symbol (dangling ref)', 9: 'special-casing / overfit', async_done: 'false completion (async)',
  B1: 'RLS off on new table', B3: 'permissive policy (anon-readable)', B4: 'unscoped UPDATE/DELETE (no WHERE)',
  C1: 'hardcoded secret', C2: 'private key',
  R: 'compiled rule (from your docs)', P: 'procedure (step skipped / out of order)',
  ENV: 'env file not gitignored (secret-leak risk)', test_exclusion: 'test excluded/skipped to pass',
  test_weakened: 'test weakened/disabled to pass', mojibake: 'encoding corruption (mojibake)',
  agent: 'subagent cannot load (silently inert)',
  // v2 claims contract (GROUNDTRUTH_CONTRACT=1): NC = no valid claims block, CA = claim unsupported by the
  // diff/transcript, UC = a changed file no claim covers.
  NC: 'no claims contract', CA: 'claimed but absent (contract)', UC: 'undeclared change (contract)' };
const CLASS_BUCKET = { 1: 'Ignored', 2: 'Missed→Ignored', 3: 'Ignored', 4: 'Missed', 6: 'Missed→Ignored', async_done: 'Ignored',
  B1: 'Ignored', B3: 'Ignored', B4: 'Ignored', C1: 'Ignored', C2: 'Ignored', R: 'Ignored' };

// Phase-1 false-completion (async): the claim asserts done/clean AND simultaneously says the work is
// still running/deferred — a self-contradiction. Conservative: fires only when BOTH are present, so a
// plain "Done!" (no deferral) abstains (precision guard, spec §9). Warn-only — a false "you lied" is
// worse than a miss.
const COMPLETION_RE = /\b(done|complete[ds]?|finished|shipped|delivered|all set|wrapped up|clean)\b|✓|🟢|told\s*&\s*done/i;
const DEFERRAL_RE = /\b(in progress|still running|running in the background|in the background|background (?:workflow|run|job|task|agent)|i'?ll (?:deliver|continue|report|update|finish|send|hand)|when it (?:completes?|lands?|finishes?|returns?)|waiting on|watch[^.]{0,20}\/workflows|will (?:notify|deliver|update you)|kicked off|once (?:it|the run|the workflow))\b/i;
// async_done ONLY: a turn-VERDICT STAMP, not any bare "done/shipped/clean" mid-prose. The loose COMPLETION_RE
// above matches ~every engineering status message ("would've shipped bugs", "the fix is clean", "genuinely
// shipped"), so in a workflow that keeps a verifier sub-agent pending at most Stops (bgPending≈always), the
// `&& bgPending` conjunction collapses to COMPLETION_RE alone and cries wolf (23 fires/session, 13/13 sampled
// FP). The stamp form — a line-anchored "Done!/All done —/🟢 Told & Done/Shipped." or a generic-subject
// "everything's done / the work is complete" — is the honest-vs-lie tell, and it keeps the exploit ("Done!
// …oh, the deploy's still running") firing (the stamp is present) while letting "X done, Y pending" pass.
// Scope-to-stamp, per Fable's consult + a 13→1 replay on the real transcript. Line 969 keeps COMPLETION_RE.
const COMPLETION_STAMP_RE = /(^|\n)[\s>#*-]*(?:🟢\s*|✓\s*)?(?:all\s+|told\s*&\s*)?(?:done|complete[ds]?|finished|shipped|delivered|all set|wrapped up)\b\s*(?=[!.,:;()—–-]|\n|$)|\b(?:everything|the (?:work|task|job)|it)(?:'s|\s+is|\s+was)\s+(?:all\s+)?(?:done|complete[d]?|finished|shipped|delivered)\b|told\s*&\s*done|🟢/i;

// Rule-source files the compiler reads (and the --watch-rules trigger fires on). Declared, versioned
// sources only (§10) — never freeform memory.
const RULE_SRC_RE = /(^|\/)(CLAUDE|AGENTS|SCHEMA)\.md$|(^|\/)ARCHITECTURE\.md$|\.claude\/skills\/[^/]+\/SKILL\.md$|\.claude\/agents\/[^/]+\.md$|(^|\/)docs\/[^/]+\.md$|\.(cursor|windsurf)rules$/i;

// Shared classifiers — used by both Verify (analyze, on a diff) and Audit (scanContent, on whole files).
// Markers are UPPERCASE-only by convention: that avoids matching `xxx` in a URL or a `todo` variable
// (false positives are fatal). The phrase forms stay case-insensitive.
// case-insensitive (`// todo` is as much a stub as `// TODO`). The `(?![/|)])` excludes enumeration
// punctuation right after the marker (`TODO/FIXME`, `HACK)`, `XXX|…`) — a list DOCUMENTING the markers, never
// a real one, which a real marker (`TODO:`, `TODO ` + text, `TODO(user)`) still satisfies.
const STUB_MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b(?![/|)])/i;
// "not implemented" counts only as a CODE stub (thrown/raised/the language's idiom), never as free prose —
// a doc comment like "(not implemented precisely)" or a quoted external error is a design note, not debt.
// Cross-language idioms: JS `throw new …Error('…not implemented')`; Python NotImplementedError; Rust
// `todo!()`/`unimplemented!()`/`unreachable!()`; Go `panic("TODO"/"not implemented")`; Java/C#
// NotImplementedException / UnsupportedOperationException; Kotlin `TODO()`.
const STUB_PHRASE_RE = /\bNotImplementedError\b|\braise\s+NotImplemented|throw\s+new\s+\w*Error\(\s*['"`][^'"`]*not implemented|\b(?:todo|unimplemented|unreachable)!\s*\(|\bpanic[!]?\s*\(\s*['"`][^'"`]*(?:not implemented|todo)|\bNotImplementedException\b|\bUnsupportedOperationException\b|\bTODO\s*\(\s*\)/i;
const ONLY_STUB_LINE_RE = /^\s*pass\s*$/;                          // a Python body that is only `pass`
// Phrase-stubs (NotImplemented/throw…not implemented/bare `pass`) are code IDIOMS — meaningful anywhere they
// appear, so position-independent. The bare MARKER (TODO/FIXME/XXX/HACK) is different: it's debt only in
// COMMENT/PROSE position. The same token inside a string, a regex literal, JSON data, or a fenced/inline-code
// QUOTE is a MENTION, not debt — that is the self-match FP class (GT flagging its own `STUB_MARKER_RE = /…TODO…/`
// and a `// TODO` quoted inside a demo card). See stubMarkerInComment. (Fable: "firing was cheaper than lexing"
// — fix it once at the shared match layer.)
export const extOf = (p) => (String(p).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
const C_STYLE = new Set('js ts mjs cjs jsx tsx go rs java kt kts c cc cpp cxx h hpp cs swift scala php dart m mm vue svelte'.split(' '));
const HASH    = new Set('py rb sh bash yaml yml toml ex exs'.split(' '));
const DASH    = new Set('sql lua'.split(' '));
// Blank string literals so a `//`/`#` INSIDE a string ("http://…") isn't mistaken for a comment opener.
// Regex literals need no blanking — they carry no comment opener. Length-preserving (indices stay aligned).
export const blankStrings = (s) => s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, m => ' '.repeat(m.length));
// Split a source line into { code, comment }. `state` (mutated) threads block-comment (`/* */`) across
// lines — exact in full-file audit, best-effort on a diff (an opener on a prior UNCHANGED line can slip;
// documented limit, not silent). String literals are blanked only to FIND the opener, so the returned
// slices keep original text.
export function splitCodeComment(rawLine, ext, state) {
  const cat = C_STYLE.has(ext) ? 'c' : HASH.has(ext) ? 'h' : DASH.has(ext) ? 'd' : 'x';
  const blanked = blankStrings(rawLine);
  if (state.block) {                                                    // inside an open /* … */
    const end = blanked.indexOf('*/');
    if (end === -1) return { code: '', comment: rawLine };             // whole line still comment
    state.block = false;
    const rest = splitCodeComment(rawLine.slice(end + 2), ext, state);  // code may follow the close
    return { code: rest.code, comment: rawLine.slice(0, end) + ' ' + rest.comment };
  }
  const openRe = cat === 'c' ? /\/\/|\/\*/ : cat === 'h' ? /#/ : cat === 'd' ? /--/ : /\/\/|#|\/\*|--/;
  const m = blanked.match(openRe);
  if (!m) return { code: rawLine, comment: '' };
  const code = rawLine.slice(0, m.index);
  if (m[0] === '/*') {
    const after = rawLine.slice(m.index + 2), close = blankStrings(after).indexOf('*/');
    if (close === -1) { state.block = true; return { code, comment: after }; }
    return { code: code + ' ' + after.slice(close + 2), comment: after.slice(0, close) };
  }
  return { code, comment: rawLine.slice(m.index) };                     // line comment → EOL
}
// Is this line a stub? MARKERS (`TODO`/`FIXME`/`XXX`/`HACK`) count only in COMMENT position, with inline-code
// (`…`) blanked — a comment that merely *documents* a marker (a backtick example, or prose about the
// detector) is a mention, not debt. PHRASE-idioms (NotImplemented / throw…not implemented / Rust
// `todo!()`) count only in CODE position — the idiom lives in code; the same words inside a comment are a
// mention. `pass` is a whole-line Python stub. (Ceiling per Fable: a bare `TODO` written as bare prose inside
// a comment — no backticks — is indistinguishable from a real one deterministically; that's a documented limit.)
function lineIsStub(rawLine, ext, state) {
  if (ONLY_STUB_LINE_RE.test(rawLine)) return true;
  if (ext === 'md' || ext === 'markdown') {
    if (/^\s*```/.test(rawLine)) { state.fence = !state.fence; return false; }
    if (state.fence) return false;                                     // fenced code = quotation
    const prose = rawLine.replace(/`[^`]*`/g, ' ');                    // minus inline-code spans
    return STUB_MARKER_RE.test(prose) || STUB_PHRASE_RE.test(prose);
  }
  const { code, comment } = splitCodeComment(rawLine, ext, state);
  return STUB_MARKER_RE.test(comment.replace(/`[^`]*`/g, ' ')) || STUB_PHRASE_RE.test(code);
}

// Paths whose findings are noise, not delivery — excluded from the per-turn SCAN entirely (Fable: audit the
// delivery, not the sandbox). GT's OWN state is integrity-signed (a stronger sensor already covers it);
// out-of-repo throwaways (scratchpad/tmp, absolute paths, ../ escapes that reach the scan via the tool-ledger)
// are not deliverables. This removes a redundant weaker sensor over files a dedicated stronger one covers.
export function excludedScanPath(f) {
  return /^\//.test(f)                                        // absolute → outside the diffed repo tree
    || /(^|\/)\.\.\//.test(f)                                 // parent-dir escape
    || /(^|\/)(?:tmp|temp|scratch|scratchpad)\//i.test(f)     // throwaway sandboxes
    || /(^|\/)\.claude\/groundtruth\//.test(f);               // GT's own state (covered by the integrity signature)
}
// Drop whole excluded FILE blocks from a unified-diff string (content before the first `+++` header is kept).
export function dropExcludedFiles(diff) {
  return String(diff).split(/(?=^\+\+\+ b\/)/m)
    .filter(b => { const m = b.match(/^\+\+\+ b\/(.+)$/m); return !m || !excludedScanPath(m[1]); })
    .join('');
}

// Source-file extensions recognized when a filename is NAMED in prose (Class-3 no-op claims, deliverable
// tracking, intent gradeability). Broad on purpose — matching a CLAIMED filename should work in any
// language. Distinct from CODE_EXT_RE, the narrower code-only set the --audit walker scans for stub/phantom
// debt (markup/docs/config are matchable-as-claims but a `TODO` in a .md/.yaml is content, not debt).
const SRC_EXT = 'js|ts|mjs|cjs|jsx|tsx|py|go|rs|rb|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|php|swift|scala|sh|bash|m|mm|vue|svelte|ex|exs|clj|cljs|lua|dart|html|css|scss|sql|json|yaml|yml|toml|md';
const CODE_EXT_RE = /\.(js|ts|mjs|cjs|jsx|tsx|py|go|rb|java|rs|php|kt|kts|c|cc|cpp|cxx|h|hpp|cs|swift|scala|sh|bash|m|mm|ex|exs|clj|cljs|lua|dart)$/i;

// Phantom-ref (Class 4) is language-aware. Only languages whose relative imports resolve by FILE EXISTENCE
// UNAMBIGUOUSLY are checked: JS/TS module resolution, and Ruby `require_relative` (relative to the file by
// language definition). Everything else ABSTAINS — Python's dotted/package imports, Go/Rust/Java/Kotlin/C#/
// Swift (package-qualified), and C/C++/PHP (build `-I` / include_path search) can be "not found here" yet
// valid, so a file-existence check would FALSE-flag. Emit nothing rather than guess (the comment on the
// Class-4 loop already abstains on bare/package specifiers; this generalizes that to whole languages).
// Each entry: which files it applies to, the relative-import regex (capturing the spec), resolver suffixes.
const IMPORT_LANGS = [
  { ext: /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i,
    re: /(?:\bfrom|\bimport|\brequire\s*\()\s*['"](\.[^'"]+)['"]/,
    suffixes: ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.mjs', '/index.ts'] },
  { ext: /\.rb$/i,
    re: /\brequire_relative\s+['"](\.{0,2}\/?[^'"]+)['"]/,
    suffixes: ['', '.rb'] },
];
const importLang = (file) => IMPORT_LANGS.find(l => l.ext.test(file));

// Recognized test/build invocations across mainstream toolchains (Class-1 "did a test/build actually run
// before claiming it passed"). Broad on purpose: a non-JS repo that ran `go test` / `cargo test` / `rspec`
// / `mvn test` / `pytest` must NOT be mis-flagged "no test ran" (the false BLOCK on non-JS repos). Residual:
// a truly exotic runner outside this set still reads as "not run" — block is opt-in (default warn), so that
// is a documented limit, not a silent false block (see ROADMAP: per-language block-degrade).
const TEST_BUILD_RE = /\b(npm (?:test|run (?:build|lint|typecheck))|yarn (?:test|build|lint)|pnpm (?:test|build|lint)|bun (?:test|run)|deno (?:test|task|check)|node --check|node\s+[^|;&]*\.test\.|vitest|jest|mocha|ava|playwright|cypress|tsc|pytest|tox|nox|unittest|go (?:test|build|vet)|cargo (?:test|build|check|clippy)|(?:bundle exec )?rspec|rails test|rake test|minitest|(?:\.\/)?(?:mvnw?|gradlew?)\b[^|;&]*\b(?:test|verify|build|check)|phpunit|pest|dotnet (?:test|build)|ctest|cmake --build|make(?:\s+[\w.-]+)?|swift test|bats|mix test|lein test|clojure -M:test)\b/;
// Test/spec files across languages — JS (.test./.spec.), Go (_test.go), Python (test_*.py / *_test.py),
// Ruby (*_spec.rb), Elixir (*_test.exs), plus conventional dirs (tests/, __tests__/, spec/, src/test/).
// Drives the Class-1 "whole diff is tests" anti-gaming warn AND the remediation gaming guard (GAMED_FILE_RE).
export const TEST_FILE_RE = /\.test\.|\.spec\.|_test\.(?:go|py|rb|exs?|java|kt|cc|cpp|c)\b|(^|\/)test_[^/]*\.py\b|_spec\.rb\b|(^|\/)(?:tests?|__tests__|spec)\/|(^|\/)src\/test\//i;
// Class 9 — special-casing the evaluator (RHB "overfit-to-visible-check"): source that detects it's under
// test/CI/audit so it can behave differently. High-confidence: gaming Groundtruth itself (reads the plugin's
// own env vars, or writes one of its suppression tokens into source). Heuristic: a test/CI env probe in
// NON-test source. NOTE: warn-only + one-per-turn — real app code legitimately has test-mode config, so
// this is a smell to confirm, not proof; tighten the env-probe arm if it gets noisy. Self-match-proof: the
// arms need real access syntax (escaped dots/brackets), so this definition line can't trip itself.
// Two arms, tested on DIFFERENT views (the fix for the comment-mention FP that fired on this repo's own
// AG-A comment "// … GROUNDTRUTH_KEY …"):
//   • EVAL_CODE_RE — an actual runtime BRANCH on the evaluator (env/CI/test-mode). Tested on the CODE portion
//     only (comments stripped) — a comment that merely NAMES the env var is documentation, not a branch.
//   • EVAL_SUPPRESS_RE — a Groundtruth SUPPRESSION directive written into source. Like an eslint-disable, it
//     is a comment, so it matches whole-line — but the token must sit RIGHT AFTER a comment-opener (a
//     DIRECTIVE), not embedded mid-prose, else a comment merely NAMING the token (like this very line) self-
//     matches. So documentation that mentions the token in backticks/prose is not flagged; a real directive is.
const EVAL_CODE_RE = /GROUNDTRUTH_[A-Z]\w*|process\.env\.CI\b|process\.env\.\w*_?ENV\s*===?\s*['"]test|os\.environ(?:\.get\(|\[)\s*['"](?:CI|PYTEST)|ENV\[['"](?:CI|RAILS_ENV)|\bif\b[^;\n]{0,40}\b(?:is_?test|under_?test|in_?test|testing_?mode)\b/i;
const EVAL_SUPPRESS_RE = /^groundtruth[-_](?:ok|off|skip|disable|ignore)/i;   // tested against the (trimmed, language-aware) COMMENT portion — a real directive STARTS the comment

// Secret detection (catalog C1/C2) — distinctive provider prefixes + the PEM private-key header.
// Known-format only (gitleaks' lane for the long tail); low false-positive, so verdict-grade.
// Patterns are written so their own source literal can't self-match (the `[...]` quantifier form
// never satisfies the char-class it describes), so editing this file never self-flags.
const SECRET_RES = [
  ['C1', 'AWS access key',  /\bAKIA[0-9A-Z]{16}\b/],
  ['C1', 'GitHub token',    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['C1', 'Stripe live key', /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ['C1', 'Google API key',  /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['C1', 'Slack token',     /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['C2', 'private key',     /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/],
];
// Published, vendor-documented EXAMPLE credentials — literally never real, so recognizing the exact STRING
// (not the file it lives in) lets an example key never buy a false BLOCK while a real high-entropy key in
// the same file still blocks. Decide on CONTENT, not location — location is attacker-choosable (Fable). The
// AWS docs example access key is the one that produced our live block-severity FP (it's in the red-team).
const EXAMPLE_SECRETS = new Set([
  'AKIAIOSFODNN7EXAMPLE',                                   // AWS documentation's example access key id
]);
// A token/line carrying a synthetic marker is a placeholder, not a leak → DEMOTE to warn (never silence:
// the finding stays on the card, so "hide a real key behind a FAKE_ comment" can't silently pass — it's
// just no longer a block). Real secrets opt OUT of the test-path demotion other checks get, precisely
// because a fixture secret is sometimes real; only self-marking / allowlisted ones demote.
// letter-boundaries (not \b): `_`/digits count as boundaries so `FAKE_KEY`/`TEST_KEY` match, but a real
// word like `FAKER`/`SAMPLED` does not (a letter on either side blocks it).
const SYNTHETIC_MARKER_RE = /(?<![A-Za-z])(?:EXAMPLE|SAMPLE|FAKE|DUMMY|PLACEHOLDER|REDACTED|XXXX+|YOUR|TEST[_-]?KEY|NOT[_-]?REAL|DO[_-]?NOT[_-]?USE)(?![A-Za-z])/i;
export function isSecret(line) {
  // Also test a concat-collapsed copy so `"AKIA" + "0123456789ABCDEF"` (split to dodge the regex) is
  // caught — the runtime value is identical. Collapsing only removes string-join glue between quotes,
  // so this file's own regex literals (no such glue) still can't self-match.
  const joined = line.replace(/['"`]\s*[+.&]\s*['"`]/g, '');
  for (const [id, label, re] of SECRET_RES) {
    const m = re.exec(line) || re.exec(joined);
    if (m) {
      // Decide on the KEY TOKEN ITSELF only — never on the rest of the line. A marker ANYWHERE on the line
      // ("// example", a `FAKE_` var name next to a live key) is attacker-choosable, so line-context demotion
      // was a block-gate bypass (Fable C1). Only an allowlisted example key or a marker INSIDE the matched
      // token (e.g. `AKIAIOSFODNN7EXAMPLE`) demotes; every other real-format key still blocks.
      const benign = EXAMPLE_SECRETS.has(m[0]) || SYNTHETIC_MARKER_RE.test(m[0]);
      return { id, label, benign };
    }
  }
  return null;
}

// Env-file exposure (security) — a real `.env` must never be committable. `.env.example` / `.sample` /
// `.template` are MEANT to be committed (no secrets), so they're exempt. Grounded in git, not inferred:
//   tracked (in the index)             → BLOCK: secret already in history — `git rm --cached` it + rotate
//   on disk, untracked AND not ignored → WARN: one `git add` from leaking — add it to .gitignore
//   properly ignored                   → silent (correct — it appears in neither list)
const ENV_FILE_RE = /(^|\/)\.env(\.[\w-]+)*$/i;
const ENV_EXEMPT_RE = /\.(example|sample|template|dist|md)$/i;
const isSecretEnvFile = (p) => ENV_FILE_RE.test(p) && !ENV_EXEMPT_RE.test(p);

/** Pure: classify env files into findings. tracked/untracked are path lists. Exported for the self-check. */
export function envFindings(tracked = [], untracked = []) {
  const out = [];
  for (const f of tracked) if (isSecretEnvFile(f))
    out.push({ cls: 'ENV', sev: 'block', file: f, msg: `env file committed to git: ${f} — \`git rm --cached\` it, gitignore it, and rotate any secret it held` });
  for (const f of untracked) if (isSecretEnvFile(f))
    out.push({ cls: 'ENV', sev: 'warn', file: f, msg: `env file present but NOT gitignored: ${f} — one \`git add\` from committing secrets; add it to .gitignore` });
  return out;
}

/** git-grounded wrapper: tracked = the index; untracked = `??` rows (ignored files show in neither, so a
 *  properly-ignored .env is correctly silent). `git(args)` returns stdout (the bound helper from main). */
function collectEnv(git) {
  const tracked = git('ls-files').split('\n').filter(Boolean);
  // NOTE: paths with spaces are `"`-quoted by porcelain; env files rarely have spaces, so left as-is.
  const untracked = git('status --porcelain --untracked-files=all').split('\n')
    .filter(l => l.startsWith('??')).map(l => l.slice(3).trim());
  return envFindings(tracked, untracked);
}

/** Does a relative import spec (from a repo-relative file) resolve to a real file? `suffixes` are the
 *  language's resolver candidates (e.g. JS tries .js/.ts/index.js; Ruby tries .rb). */
function relImportResolves(cwd, fileRelPath, spec, suffixes) {
  const target = resolve(cwd, dirname(fileRelPath), spec);
  return suffixes.some(ext => existsSync(target + ext));
}

/** Changed file paths from a unified diff's `+++ b/...` headers. */
function changedFiles(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]).filter(f => f !== '/dev/null');
}

/** Did a commit (or history-moving op) run this session? A missing baseline only HIDES work if something
 *  was actually committed — otherwise diffing against HEAD loses nothing. Grounded in the recorded commands.
 *  NOTE: substring match — a laundered commit (via a script) is missed, erring toward "no commit" →
 *  warn not block; that's the in-session ceiling, CI is the real enforcement boundary. */
export function sessionHasCommit(cmds = []) {
  return (cmds || []).some(c => /\bgit\s+(?:commit|merge|cherry-pick|revert|am|rebase)\b|\bgh\s+(?:pr\s+merge|merge)\b/.test(String(c)));
}

// Quote-strip for the Class-1 claim scan (Defect A): a "tests pass" that is QUOTED or ATTRIBUTED is
// discussion, not a first-person claim — the FP that silently block-looped when the agent echoed a finding
// message or a doc line. Blank fenced ``` code blocks and `> ` blockquote lines WHOLESALE (length-preserving,
// with `\n` kept, so the caller's offset-based sentence-scoping still aligns), and return the surviving
// inline `code` span ranges: a claim match that falls ENTIRELY inside one is quoted and excused, while a
// match that STRADDLES a span ("All `tests` pass" — the backticked word plus a bare verb) is a real claim and
// still fires (no blank-and-rescan, which would launder that real claim into a false negative). Pure → tested.
export function stripQuotedForClaim(s = '') {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const scan = String(s)
    .replace(/```[\s\S]*?```/g, blank)          // fenced code blocks
    .replace(/^[ \t]*>.*$/gm, blank);           // blockquote lines
  const inlineSpans = [];
  for (const m of scan.matchAll(/`[^`\n]+`/g)) inlineSpans.push([m.index, m.index + m[0].length]);
  return { scan, inlineSpans };
}

// AG-B (config/build test-exclusion): the agent claims success but reached green by SKIPPING/EXCLUDING the
// tests or LOWERING the coverage gate — not by fixing the code. Two channels: added lines in a build/config
// file (diff walker) and skip-flags on the command line (bashCmds). Gated on a success claim so a routine
// config edit isn't flagged. Warn-only (heuristic). Pure → tested.
const BUILD_CFG_RE = /(^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.nycrc(?:\.json)?|karma\.conf\.[jt]s|package\.json)$/i;
// `-x test` is a Gradle exclude-task flag — anchor it to a gradle invocation so it can't false-match an
// unrelated `-x` (tar/ls/flock … `-x test.tar`), which would be a false gaming accusation (Fable re-review).
const CMD_SKIP_TESTS_RE = /-DskipTests|-Dmaven\.test\.skip|\bgradlew?\b[^|;&]*\s-x\s+(?:test|check)\b|--testPathIgnorePatterns|--passWithNoTests/;
const CFG_EXCLUDE_RE = [
  /<skipTests>\s*true/i, /<skip>\s*true<\/skip>/i,          // maven surefire skip
  /<exclude>[^<]*[Tt]est[^<]*<\/exclude>/,                  // surefire <excludes> a Test
  /\btest\s*\.\s*enabled\s*=\s*false/, /\bexclude\s+['"][^'"]*[Tt]est/,   // gradle disable / exclude
  // jest ignore ONLY when the added value names a test/spec path — a bare `testPathIgnorePatterns:
  // ["/node_modules/"]` is boilerplate in nearly every honest jest config and must NOT flag (Fable FP #1).
  /testPathIgnorePatterns[^\n]*(?:\.(?:test|spec)\.|[Tt]ests?\/|__tests__|[Ss]pec)/,
];
// A success/completion claim, negation- and quote-aware (Fable FP #3): reuses stripQuotedForClaim so an
// echoed/quoted claim doesn't count, and abstains on a hedged/negated sentence ("Not done yet", "still WIP")
// — the loose bare-word gate fired on honest self-disclosing turns. Deliberately conservative (a missed gate
// is a warn-tier FN, an over-open one is the fatal FP). Pure → tested.
const SUCCESS_CLAIM_RE = /\b(?:done|fixed|passes|passed|green|complete[d]?|all\s+tests?\s+pass\w*|tests?\s+pass\w*|works\b)\b/i;
// Deliberately does NOT include `no` / `fail\w*` / `broken`: those wrongly suppressed the exact phrasing the
// checks TARGET — "Fixed the failing test, all green" and "it works, no errors" are success claims (Fable
// re-review FN). Present-tense hedges (not/never/n't/yet/still/wip) still gate the honest-WIP cases.
const CLAIM_HEDGE_RE = /\b(?:not|never|n[’']t|yet|still|wip|todo|unfinished|incomplete|before|once|when|if|should|would|will|make sure|ensure|trying|about to|going to|need|can[’']t|couldn)\b/i;
export function claimsSuccess(claim = '') {
  const { scan, inlineSpans } = stripQuotedForClaim(claim);
  // Blank inline `code` spans too (the gate has no straddle concern — a fully-quoted claim must not open it).
  let s = scan;
  for (const [a, b] of inlineSpans) s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
  for (const sent of s.split(/[.!?\n]+/)) {
    if (SUCCESS_CLAIM_RE.test(sent) && !CLAIM_HEDGE_RE.test(sent)) return true;
  }
  return false;
}
export function testExclusionFindings(claim = '', diff = '', bashCmds = []) {
  const out = [];
  if (!claimsSuccess(claim)) return out;  // only when success is genuinely claimed (negation/quote-aware)
  // A skip flag is only gaming if NO real test run ALSO happened — `mvn -DskipTests` to build a jar, then a
  // real `mvn test`, is honest (Fable FP #4). A real run = a TEST_BUILD command that is NOT itself a skip.
  const realRun = (bashCmds || []).some(c => TEST_BUILD_RE.test(c) && !CMD_SKIP_TESTS_RE.test(c));
  if (!realRun) for (const c of bashCmds || []) if (CMD_SKIP_TESTS_RE.test(c)) {
    out.push({ cls: 'test_exclusion', sev: 'warn', msg: `claimed success, but a command SKIPPED the tests instead of running them (${c.trim().slice(0, 50)}) — verify the suite actually ran` }); break;
  }
  // per-file added/removed lines (for exclusion patterns + paired coverage-threshold lowering)
  const byFile = {}; let cur = '';
  for (const l of String(diff).split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/); if (h) { cur = h[1] === '/dev/null' ? '' : h[1]; continue; }
    if (!cur) continue;
    if (l[0] === '+' && !l.startsWith('+++')) (byFile[cur] ||= { add: [], del: [] }).add.push(l.slice(1));
    else if (l[0] === '-' && !l.startsWith('---')) (byFile[cur] ||= { add: [], del: [] }).del.push(l.slice(1));
  }
  const nums = (lines) => { const m = {}; for (const ln of lines) for (const x of ln.matchAll(/(?:"?(branches|functions|lines|statements)"?\s*:\s*|<minimum>\s*)(\d+(?:\.\d+)?)/gi)) m[(x[1] || 'minimum').toLowerCase()] = parseFloat(x[2]); return m; };
  for (const [f, { add, del }] of Object.entries(byFile)) {
    if (!BUILD_CFG_RE.test(f)) continue;
    const base = f.split('/').pop();
    const ex = add.find(a => CFG_EXCLUDE_RE.some(re => re.test(a)));
    if (ex) out.push({ cls: 'test_exclusion', sev: 'warn', msg: `claimed success, but ${base} adds a test skip/exclusion (${ex.trim().slice(0, 50)}) — verify the excluded tests still run and pass` });
    const dn = nums(del), an = nums(add);
    for (const k of Object.keys(an)) if (k in dn && an[k] < dn[k]) { out.push({ cls: 'test_exclusion', sev: 'warn', msg: `claimed success, but a coverage threshold was LOWERED in ${base} (${k} ${dn[k]}→${an[k]}) — verify coverage wasn't dropped just to pass the gate` }); break; }
  }
  return out;
}

// AG-C (assertion-downgrade / disable on baseline tests): the agent turned an EXISTING test green by
// WEAKENING it, not by fixing the code. Two signals, both claim-gated + warn-only:
//   • a strict assertion (assertEquals / toBe / assertThat…isEqualTo) REPLACED by a loose one (assertNotNull
//     / toBeTruthy / …isNotNull) — measured as NET COUNTS per file, which is robust against the framework-
//     migration FP Fable flagged (assertEquals→toBe is strict→strict, so the strict count doesn't drop);
//   • a NET-NEW skip/disable (@Disabled / it.skip / xit / @pytest.mark.skip) added to a baseline test.
// Anchored to "baseline": only fires on a file that has REMOVED lines (it existed at session start) — a
// brand-new test file (adds only) passes free (legit TDD). Pure → tested. Delta-widening + case-level
// deletion are DEFERRED (need pairing / a whole-tree lookup) — named, not half-built.
// STRICT = an exact assertion (value/identity/called-with). LOOSE = an existence/partial/boolean weakening.
// `assertThat` is a CARRIER, not an assertion — strictness lives in the chained matcher (isEqualTo vs
// isNotNull), so it is in NEITHER table (Fable #9). `toContain`/`toHaveLength` are LOOSE (exact→partial is a
// downgrade — launch-kit pattern #2). The tables must not overlap: `\.toBe\s*\(` can't match `toBeTruthy(`.
const STRICT_ASSERT_RE = /\bassert(?:Equals|Same|ArrayEquals)\b|\.(?:toBe|toEqual|toStrictEqual|toHaveBeenCalledWith)\s*\(|\bis(?:EqualTo|SameAs)\b/;
const LOOSE_ASSERT_RE = /\bassert(?:NotNull|True|False|Null)\b|\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeNull|toContain|toHaveLength)\s*\(|\.toHaveBeenCalled\s*\(\s*\)|\bis(?:NotNull|NotEmpty)\b/;
const TEST_SKIP_RE = /@Disabled\b|@Ignore\b|@pytest\.mark\.skip|@unittest\.skip|\bit\.skip\s*\(|\bxit\s*\(|\btest\.skip\s*\(|\bdescribe\.skip\s*\(|\bxdescribe\s*\(|\.skip\s*\(\s*['"`]/;
export function testWeakeningFindings(claim = '', diff = '') {
  const out = [];
  if (!claimsSuccess(claim)) return out;   // negation/quote-aware success gate (Fable #3)
  const count = (lines, re) => lines.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0);
  const byFile = {}; let cur = '';
  for (const l of String(diff).split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/); if (h) { cur = h[1] === '/dev/null' ? '' : h[1]; continue; }
    if (!cur || !TEST_FILE_RE.test(cur)) continue;
    if (l[0] === '+' && !l.startsWith('+++')) (byFile[cur] ||= { add: [], del: [] }).add.push(l.slice(1));
    else if (l[0] === '-' && !l.startsWith('---')) (byFile[cur] ||= { add: [], del: [] }).del.push(l.slice(1));
  }
  for (const [f, { add, del }] of Object.entries(byFile)) {
    if (!del.length) continue;                          // a NEW test file (adds only) → legit, never flag (TDD)
    const base = f.split('/').pop();
    // net-new skip/disable on a baseline test (in added, not already in removed)
    const skip = add.find(a => TEST_SKIP_RE.test(a)) && !del.some(d => TEST_SKIP_RE.test(d)) ? add.find(a => TEST_SKIP_RE.test(a)) : null;
    if (skip) out.push({ cls: 'test_weakened', sev: 'warn', msg: `claimed success, but an existing test was DISABLED/skipped in ${base} (${skip.trim().slice(0, 50)}) — that turns it green without fixing the code` });
    // strict→loose downgrade, by net count (migration-safe: strict→strict doesn't drop the strict count)
    const rmStrict = count(del, STRICT_ASSERT_RE), addStrict = count(add, STRICT_ASSERT_RE);
    const rmLoose = count(del, LOOSE_ASSERT_RE), addLoose = count(add, LOOSE_ASSERT_RE);
    if (rmStrict >= 1 && addStrict < rmStrict && addLoose > rmLoose) {
      // Net-count evidence: do NOT quote a specific added line (net-counting can't identify WHICH line, and
      // pointing at an unrelated new assertion is misleading — Fable #5). State the net movement instead.
      out.push({ cls: 'test_weakened', sev: 'warn', msg: `claimed success, but ${base}'s strict assertions dropped (${rmStrict}→${addStrict}) while looser ones were added — verify the code was fixed, not the tests relaxed` });
    }
  }
  return out;
}

// MOJIBAKE — encoding corruption. UTF-8 bytes read as Latin-1/CP1252 and re-saved as UTF-8, so every
// non-ASCII char in the file is silently mangled (an em-dash becomes a 3-char sequence). The code still
// RUNS — which is exactly why nothing catches it: the source STRINGS are corrupt, so the program faithfully
// emits garbage.
// REAL INCIDENT (hindsight, commit 1618e35): a bad write re-encoded api/_lib/autoPublish.js — 756 mangled
// sequences; the daily email shipped garbage for days. Its PARENT commit was clean and 365 of the 374 ADDED
// lines carried mojibake, so a staged-diff scan would have caught it AT COMMIT TIME. That is the whole point
// of this check, and why it is deliberately NOT claim-gated: corrupted bytes are corrupted regardless of what
// the agent SAID, and the pre-commit/CI paths pass claim:'' — a claim-gated check would be inert exactly at
// the gate where it earns its keep.
// SIGNATURE: a UTF-8 LEAD byte seen as a char (0xC2→Â 0xC3→Ã 0xE2→â 0xF0→ð) IMMEDIATELY followed by a
// CONTINUATION byte (0x80–0xBF) seen as a char. Under Latin-1 the continuation lands in the C1 CONTROL range
// (–, invisible); under CP1252 those slots map to printable specials (€ ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž
// ' ' " " • – — ˜ ™ š › œ ž Ÿ). BOTH are covered — the Latin-1 half is the one that actually fired here, and
// it is invisible in a terminal, which is why this hid for so long.
// SCOPE (honest): Latin-1/CP1252 misreads only — including double-encoding, whose output still contains these
// pairs. It does NOT catch U+FFFD replacement damage, UTF-16/BOM garbage, or UTF-8 misread as CP1251/KOI8-R/
// Shift-JIS — different signatures; abstaining there beats guessing.
// ADDED lines only — so a REPAIR commit (mojibake only on the `-` side) stays silent, for free.
const MOJI_CONT = '[\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039'
  + '\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A'
  + '\\u0153\\u017E\\u0178]';                                         // continuation byte (0x80-0xBF) seen as a char
// ARITY IS THE FP KILLER: each lead requires EXACTLY the continuation count real UTF-8 carries — Â/Ã (2-byte
// lead) one, â (3-byte) two, ð (4-byte) three. The draft made the 2nd/3rd continuation OPTIONAL, so a legit
// letter followed by ONE continuation-class char fired: Icelandic ð is a real word-final letter and smart
// punctuation is in the CP1252 continuation set, so „það“ / ‘það’ / það… / það—og all false-fired (live probe,
// v1.3.0 review). Real mojibake ALWAYS carries full arity, so requiring it costs no recall on the incident class.
// Continuations for the 2-byte leads are further restricted to raw 0x80-0xBF (no CP1252 specials): CP1252 and
// Latin-1 agree on 0xA0-0xBF, so this only drops CP1252-misread of UPPERCASE 0xC0-0xDF letters — and it removes
// the whole "word-final letter + smart punctuation" legit-adjacency class ("ATÉ AMANHÃ…" false-fired in the same probe).
const MOJIBAKE_RE = new RegExp('[\\u00C2\\u00C3][\\u0080-\\u00BF]'
  + '|\\u00E2' + MOJI_CONT + '{2}'
  + '|\\u00F0' + MOJI_CONT + '{3}', 'g');
// â/ð + full arity is STRONG evidence: 2-3 CONSECUTIVE continuation-class chars never occur in legitimate text.
// A 2-byte-lead pair is WEAK: caps-Portuguese word-final letter immediately before a closing guillemet (0xBB) —
// IRMA-tilde inside tight French quotes — is a real if exotic legit adjacency, so it needs corroboration (the
// >=2 gate below). Spelled out, not quoted literally, so this comment can never self-match its own check.
const MOJI_STRONG_LEAD = /[\u00E2\u00F0]/;
// CP1252 specials → their byte, for the round-trip. The draft masked with `& 0xff`, which is WRONG for these
// (€ is U+20AC → & 0xff = 0xAC, but the CP1252 byte for € is 0x80) — a CP1252-misread "…" decoded to "⬦" and
// the card mis-NAMED the character; most other CP1252 sequences round-tripped dirty and lost the name entirely.
const CP1252_BYTE = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B,
  'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A,
  '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F };   // literal keys: if THIS file is ever re-encoded, MOJIBAKE_RE
  // (built from ASCII escapes) still detects the damage — only the "looks like" naming degrades. Detection never
  // depends on this table.
// Best-effort round-trip: map the mangled chars back to the bytes they were misread from and decode as UTF-8 to
// recover what the character SHOULD have been — so the finding says "looks like '—'" instead of an escape blob.
function mojibakeDecode(seq) {
  try {
    const out = Buffer.from([...seq].map((c) => CP1252_BYTE[c] ?? (c.codePointAt(0) & 0xff))).toString('utf8');
    // U+FFFD -> not a clean round-trip; a C0/C1 CONTROL result (e.g. the 0xC2 0x80 pair decodes to U+0080)
    // would put an invisible byte on the verdict card. Either way: do not guess.
    return !out || /[\uFFFD\u0000-\u001F\u007F-\u009F]/.test(out) ? null : out;
  } catch { return null; }
}
export function mojibakeFindings(diff = '') {
  const out = [];
  const byFile = Object.create(null); let cur = '';   // null-proto: a file literally named __proto__ made `{}`'s ||= resolve to Object.prototype and crash .push
  for (const l of String(diff).split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/); if (h) { cur = h[1] === '/dev/null' ? '' : h[1]; continue; }
    if (!cur || l[0] !== '+' || l.startsWith('+++')) continue;       // ADDED lines only (a repair stays silent)
    const hits = l.slice(1).match(MOJIBAKE_RE);
    if (hits) (byFile[cur] ||= []).push(...hits);
  }
  for (const [f, hits] of Object.entries(byFile)) {
    // ABSTAIN when the whole case is ONE weak (2-byte-lead) pair: that is the residual legit-adjacency class
    // (see the WEAK comment above). Any strong hit, or two-plus hits, reports — the real incident had 756.
    if (hits.length < 2 && !MOJI_STRONG_LEAD.test(hits[0][0])) continue;
    // Report the most frequent sequence — with what it decodes back to, when the round-trip is clean.
    const freq = {}; for (const h of hits) freq[h] = (freq[h] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    const was = mojibakeDecode(top);
    out.push({ cls: 'mojibake', sev: 'warn',
      msg: `encoding corruption in ${f.split('/').pop()} — ${hits.length} mangled sequence${hits.length > 1 ? 's' : ''} added`
         + (was ? ` (most common looks like a garbled "${was}")` : '')
         + `: the file was read as Latin-1 and re-saved as UTF-8, so its string literals are corrupt. The code still RUNS and ships the garbage — re-decode the affected runs, do NOT re-encode the whole file (genuine UTF-8 added since would be destroyed)` });
  }
  return out;
}

// ── AGENT INTEGRITY — a subagent that can NEVER load, and a doc that rests on one ───────────────────
// This is the house rule "fail-loud on silent-inertness" applied to subagents. An agent that cannot load
// fails OPEN: no error, no log, it simply never fires — and every rule documented as "enforced by the X
// subagent" then rests on nothing. That is the same false-confidence the INERT-rule check already surfaces
// for a compiled rule whose regex won't compile, and the same class as a phantom import (Class 4): a
// reference that does not resolve.
// REAL INCIDENT (hindsight): 16 agents lived in `hindsight-vercel/.claude/agents/` — one level BELOW the
// repo root. Claude Code resolves `.claude/agents/` by walking from the CWD *upward*; it never descends. So
// launched from the repo root (the normal case) not one of them was ever scanned — silently, for weeks —
// while CLAUDE.md claimed migrations were "enforced by the auto-invoked migration-reviewer subagent".
// Every check below is a STATIC property of the files: no LLM, no runtime, no model list.
// SCOPE (deliberate): we prove an agent CANNOT fire. We never claim one WILL — selection is the model's
// discretion (a `description` is a nudge, not a guarantee), and asserting otherwise would be exactly the
// overclaim the positioning guard forbids. All five real failure modes lived in "cannot fire".
const AGENT_STOPWORD = /^(?:the|a|an|this|that|each|any|some|no|your|my|our|its|their|first|second|next|last|other|same|right|correct|relevant|appropriate|auto|sub|new|old)$/i;
/** Parse a subagent markdown file's YAML frontmatter. Pure. */
export function parseAgentFile(src = '') {
  // Strip a UTF-8 BOM before matching: a BOM'd agent file still loads (YAML loaders strip it), so reporting
  // it as "NO frontmatter — can never load" was a verified FP in the v1.3.1 adversarial review. Strip, don't judge.
  const fm = String(src).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { frontmatter: false };
  const g = (k) => {
    const m = fm[1].match(new RegExp('^' + k + ':[ \\t]*(.*)$', 'm'));
    if (!m) return '';
    const v = m[1].trim();
    // YAML BLOCK SCALAR (`description: >-` + indented lines): the value is the FOLLOWING indented block, not
    // the `>-` indicator. The draft returned the indicator itself, so two agents with different multiline
    // block-scalar descriptions both parsed as ">-" and false-fired "byte-identical description" (verified FP,
    // v1.3.1 review). Fold the indented lines — enough for presence + identity comparison, which is all the
    // callers need.
    if (/^[>|][0-9]*[+-]?$/.test(v)) {
      const folded = [];
      for (const l of fm[1].slice(m.index + m[0].length).split('\n').slice(1)) {
        if (l.trim() === '') continue;
        if (!/^[ \t]/.test(l)) break;                      // dedent ends the block
        folded.push(l.trim());
      }
      return folded.join(' ');
    }
    // A QUOTED value keeps everything inside the quotes; a plain scalar drops a trailing YAML comment —
    // `name: qa-bot # main QA agent` parses as `qa-bot` per YAML (` #` starts a comment in plain scalars).
    // The draft kept the comment in the value, which broke the doc-reference cross-check for that agent
    // (a doc's `qa-bot` no longer matched the loadable name → phantom-ref FP, verified in review).
    const q = v.match(/^(["'])([\s\S]*?)\1/);
    return q ? q[2] : v.replace(/\s+#.*$/, '');
  };
  return { frontmatter: true, name: g('name'), description: g('description'), model: g('model') };
}
/**
 * Pure core. `agents` = [{ rel, src }] for every `**\/.claude/agents/*.md` (rel = repo-relative path);
 * `docs` = [{ rel, src }] for the rule docs that may REFERENCE an agent (CLAUDE.md & friends).
 */
export function agentFindings(agents = [], docs = []) {
  const out = [];
  const loadable = new Map();          // name → rel, for agents that CAN load
  const byBase = new Map();            // file basename → rel, for cross-referencing a doc mention
  const seenName = new Map(), seenDesc = new Map();
  for (const { rel, src } of agents) {
    // Keyed lower-case: the doc cross-check resolves case-insensitively (a sentence-start "Reviewer" must
    // still resolve to `reviewer.md`). Display always uses the original spelling.
    byBase.set(rel.split('/').pop().replace(/\.md$/, '').toLowerCase(), rel);
    const a = parseAgentFile(src);
    // (1) LOCATION — the failure that hid 16 agents. `.claude/agents/` is resolved by walking from the CWD
    // UPWARD to the repo root; a copy nested below the root is never descended into. Stated precisely: it is
    // invisible when Claude is launched from the repo root (the normal case). It DOES load if you launch from
    // inside that subtree — so this is a warn about the normal case, not an absolute "never".
    const nested = !/^\.claude\/agents\//.test(rel);
    if (nested) {
      const sub = rel.split('/.claude/')[0];
      out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel.split('/').pop()} is in ${sub}/.claude/agents/ — BELOW the repo root. Claude Code resolves .claude/agents/ from the CWD upward and never descends, so it is invisible whenever you launch from the repo root (the normal case). Move it to <root>/.claude/agents/` });
    }
    // (2) FRONTMATTER — `name` and `description` are required; without them the file cannot load at all.
    if (!a.frontmatter) { out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel} has NO YAML frontmatter — \`name\` and \`description\` are required, so it can never load (it is inert, not merely unused)` }); continue; }
    if (!a.name) out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel} has no \`name:\` in its frontmatter — it cannot load` });
    if (!a.description) out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel} has no \`description:\` — it cannot load, and description is also HOW the router selects an agent` });
    // (3) MODEL ID — a malformed id is a SILENT fallback, not a loud error. We deliberately do NOT keep an
    // allowlist of valid models: it would go stale and false-fire on the next model shipped (an FP is fatal;
    // this check must age well). A DOT in a BARE Claude id is the provably-wrong shape — Anthropic-API ids are
    // hyphen-separated (`claude-opus-4-8`), never dotted — which is exactly the real bug (`claude-opus-4.8`).
    // Gated on /^claude/: BEDROCK ids legitimately contain dots (`anthropic.claude-…`, `us.anthropic.…-v1:0`)
    // and never start with `claude` — the ungated draft flagged a valid Bedrock id (verified FP, v1.3.1
    // review). Vertex ids (`claude-opus-4-1@20250805`) start with `claude` but are dot-free, so the dot test
    // itself abstains there. Anything else abstains: an unrecognised-but-well-formed id is not provably wrong.
    if (a.model && a.model.includes('.') && /^claude/i.test(a.model))
      out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel} declares \`model: ${a.model}\` — a Claude model id is hyphen-separated and never contains a dot (did you mean \`${a.model.replace(/\./g, '-')}\`?). An unrecognised id falls back SILENTLY, so this never errors` });
    // (4) ROUTER — a duplicate name collides; a byte-identical description leaves the router no way to choose
    // between two agents (selection is on description). Collisions are judged among ROOT-LEVEL agents only:
    // a nested copy never loads (finding (1) already says so, louder), so "the router cannot tell them apart"
    // would be false when one side is nested — the exact mid-migration state the location fix produces
    // (root copy added, nested original not yet deleted) must not mint a second, untrue finding.
    if (a.name) {
      const nkey = a.name.toLowerCase();            // lower-cased KEY (see byBase); the message shows the real spelling
      // The KEY is folded for DOC-PROSE resolution only (a sentence-start "Reviewer" is still reviewer.md).
      // The COLLISION test compares the real spelling: Claude Code matches `name:` as an exact string, so
      // `QALead` and `qalead` are two DISTINCT loadable agents — folding the collision test too made a false
      // "declared twice" on exactly that pair (verified FP, this review). Not provably a collision → abstain.
      const kin = seenName.get(nkey) || [];
      const prior = kin.find(p => p.name === a.name);
      if (prior && !nested && !prior.nested) out.push({ cls: 'agent', sev: 'warn', msg: `subagent name \`${a.name}\` is declared twice (${prior.rel} and ${rel}) — a name collision` });
      kin.push({ rel, nested, name: a.name });
      seenName.set(nkey, kin);
      if (!nested && a.description) loadable.set(nkey, rel);
    }
    if (a.description && !nested) {
      if (seenDesc.has(a.description)) out.push({ cls: 'agent', sev: 'warn', msg: `subagent ${rel} has a description byte-identical to ${seenDesc.get(a.description)} — the router selects on description, so it cannot tell them apart` });
      else seenDesc.set(a.description, rel);
    }
  }
  // (5) PHANTOM AGENT REFERENCE — Class 4, one artifact over: a doc claiming enforcement by an agent that
  // cannot load. Scoped to be FP-free by (a) skipping stopwords, (b) skipping a LOADABLE agent, and — the
  // load-bearing one — (c) firing ONLY when the name RESOLVES to an agent file in this repo (by basename or
  // declared name) that provably cannot load. (c) carries the whole guard: agents also come from plugins,
  // from the harness built-ins (`general-purpose`, `Explore`), and from user-level `~/.claude/agents/` —
  // none of which this scan can see — so "no file in the repo" proves NOTHING. The draft's unresolved arm
  // fired on ordinary prose ("a well-documented subagent", "a read-only subagent") and on built-ins: all
  // verified FPs, removed in the v1.3.1 review.
  // The name is matched BARE (any word), not just backticked/hyphenated. The draft required a hyphen or
  // backticks to keep the bare word "the" out — but (c) already excludes it (no `the.md` resolves), and the
  // narrow form MISSED the real incident's second phantom: CLAUDE.md said "invoke the reviewer subagent
  // until it returns APPROVED" — unhyphenated, unbackticked — while reviewer.md existed with NO frontmatter
  // and so could never load. That was a 🔴 blocker in the wild and the check walked straight past it.
  // `[*_]{0,3}` before the space: docs of this kind BOLD the name (`**reviewer** subagent`) and `\s+` alone
  // can't cross the closing emphasis marks — the widened bare-word form still missed the incident phrasing
  // whenever the author emphasised it (verified miss, this review). `s?` takes the plural. Opening emphasis
  // needs nothing: `*` is a non-word char, so \b already holds after it (only `_reviewer_` stays a miss —
  // `_` is a word char, so \b fails; accepted abstain). Neither widens the FIRE condition — resolution to an
  // unloadable repo file still carries the guard, so these add recall, not FP surface.
  for (const { rel, src } of docs) {
    const seen = new Set();
    for (const m of String(src).matchAll(/`([\w-]+)`[*_]{0,3}\s+sub-?agents?\b|\b([A-Za-z][\w-]*)[*_]{0,3}\s+sub-?agents?\b/gi)) {
      const ref = (m[1] || m[2] || '').trim();
      // Resolve CASE-INSENSITIVELY. A doc naturally capitalises the name at the start of a sentence
      // ("Reviewer subagent handles the diff") while the file is `reviewer.md` — a case-sensitive lookup
      // resolved nothing and abstained, silently missing a real phantom (verified FN). This cannot widen the
      // FP surface: the fire condition is still RESOLUTION to a repo agent file that cannot load, and case is
      // not what makes a word an agent name.
      const key = ref.toLowerCase();
      if (!ref || AGENT_STOPWORD.test(ref) || seen.has(key) || loadable.has(key)) continue;
      const resolved = byBase.get(key) || seenName.get(key)?.[0].rel;
      if (!resolved) continue;                       // could be a plugin/built-in/user-level agent — abstain
      // A broken agent file's OWN body routinely names itself ("You are the reviewer subagent" — agent files
      // are also rule docs via RULE_SRC_RE). That is the file describing itself, not a doc RESTING on it, and
      // check (2) already reports the file once — firing here double-reported every frontmatter-less agent
      // whose body says its own name (verified by probe, this review).
      if (resolved === rel) continue;
      // resolved by BASENAME to a file that loads under a DIFFERENT frontmatter name: the reference is stale
      // but "CANNOT LOAD" would be false (the file loads). Abstain rather than over-claim.
      if ([...loadable.values()].includes(resolved)) continue;
      seen.add(key);
      // "unless …" hedge: a broken repo file can share a name with a working plugin/built-in agent the doc
      // actually means (a WIP `explore.md` draft beside docs that say "the Explore subagent") — this scan
      // cannot see those, so state the provable part plainly and hedge the inference (verified by probe, this review).
      out.push({ cls: 'agent', sev: 'warn', msg: `${rel} documents enforcement by the \`${ref}\` subagent, but \`${ref}\` exists (${resolved}) and CANNOT LOAD — the rule rests on nothing (a phantom reference, Class 4 over agents), unless the doc means a same-named plugin/built-in agent this scan cannot see — then the broken file is dead weight beside it` });
    }
  }
  return out;
}

// VACUOUS TEST (Class 1) — an ADDED test that provably cannot fail. This is the cheap T1 slice of the
// "passes-only-the-visible-test / asserts-nothing" class (the rest is T2, mutation testing — see ROADMAP
// "Verification tiers"). Scoped (Fable) to be FALSE-POSITIVE-free, not broad: a JS/TS test whose body
// makes NO call, no `throw`, no `await`, and no chai-`should` getter chain (ACTION_RE explains the last
// two). In JS an assertion is otherwise ALWAYS a call (`expect(...)`, `assertEquals`),
// so "no call" ⇒ "no assertion" — AND it isn't a legitimate "doesn't throw" smoke test either, because a
// smoke test CALLS the code under test. A call-free, throw-free body is dead: it can only pass. That kills
// the two FP classes a token-scan ("no `assert` keyword") dies on — a DELEGATED assertion (`checkUser(x)`
// asserting three files away) has a call, and a TABLE-DRIVEN assertion in a shared loop has a call. Fires
// ONLY on a fully-added, brace-BALANCED block: an edited test's body may live outside the diff hunk, so an
// unbalanced block abstains. JS/TS grammar ONLY — pytest/Go assert via `assert`/`t.Error` STATEMENTS, not
// calls, so "no call" would falsely flag `assert x == 1`; those files never match JS_TEST_FILE_RE.
const JS_TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?|spec)\/[^/]*\.[cm]?[jt]sx?$/i;
const TEST_OPEN_RE = /\b(?:it|test|specify)\s*\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*?\1\s*,\s*(?:async\s+)?(?:function\b[^(]*)?\([^)]*\)\s*(?:=>\s*)?\{/g;
// A "real action" in the body: a construction, a throw, a method call `.foo(`, or a bare call `foo(` that
// isn't a control-flow keyword. `console.*(…)` is stripped before this runs (an allowed no-op).
// Two call-free forms that CAN still fail are also actions (each was a verified FP in review):
// `await <expr>` — awaiting a pre-built promise rejects → fails, no call needed; and `.should` — chai's
// should-style asserts via a GETTER chain (`x.should.be.true`), the one mainstream JS assertion that is
// not a call. "No call ⇒ cannot fail" only holds once both are counted as actions.
const ACTION_RE = /\bnew\b|\bthrow\b|\bawait\b|\.\s*should\b|\.\s*[A-Za-z_$][\w$]*\s*\(|(?<![.\w$])(?!(?:if|for|while|switch|catch|return|do|else|yield|typeof|void|delete|in|of|instanceof)\b)[A-Za-z_$][\w$]*\s*\(/;
// Everything that must be blanked out of a JS body before we brace-match or look for a call, as ONE
// leftmost-first alternation. The ORDER OF SCANNING is the whole point: whichever construct OPENS first
// wins and consumes the rest, exactly as a JS lexer does. Running these as separate passes is a bug —
// blanking strings first lets an apostrophe inside prose (`// … France's longitude …`) open a phantom
// string literal that eats real code (verified FP, see vacuousTestFindings). Alternatives:
//   1. string literals — '…' and "…" cannot span a newline; `…` (template) can.
//   2. block + line comments.
//   3. a regex literal, ONLY where JS itself would lex one (after a punctuator/keyword) — so the `/` in
//      `a / b` division is never eaten (eating a division that wraps the body's only call would be an FP).
const MASKABLE_RE = new RegExp(
  /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/.source
  + '|' + /\/\*[\s\S]*?\*\/|\/\/[^\n]*/.source
  + '|' + /(?<=(?:[=(,:;!&|?{}[\n^%*+~<>-]|\breturn|\bcase|\btypeof)\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^[/\\\n])+\/[a-z]*/.source,
  'g');
export function vacuousTestFindings(claim = '', diff = '') {
  const out = [];
  if (!claimsSuccess(claim)) return out;                 // same negation/quote-aware success gate as AG-C
  const byFile = {}; let cur = '';
  for (const l of String(diff).split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/); if (h) { cur = h[1] === '/dev/null' ? '' : h[1]; continue; }
    if (!cur || !JS_TEST_FILE_RE.test(cur)) continue;
    if (l[0] === '+' && !l.startsWith('+++')) (byFile[cur] ||= []).push(l.slice(1));
    // Non-added line (context / removal / @@) between added lines → GAP sentinel. Without it, joining
    // added lines flattens the gap and an added `it(... {` + `});` WRAPPED around a context-line assertion
    // reads as a fully-added EMPTY block — a verified FP on an honest "wrap existing asserts in it()" edit
    // (same for a stray brace pair joined across two hunks). A block whose span crosses \0 abstains below.
    else { const a = byFile[cur]; if (a && a[a.length - 1] !== '\u0000') a.push('\u0000'); }
  }
  for (const [f, lines] of Object.entries(byFile)) {
    const raw = lines.join('\n');                         // quotes INTACT so the test-name string still matches
    // `mask` is length-aligned to `raw` (every blanking preserves length): strings, comments AND regex
    // literals become spaces, so a `{`/`(`/`//` inside any of them can't unbalance braces, fake a call, or
    // fake a comment. We MATCH the declaration on `raw` (needs the quotes) but do all brace-matching +
    // action detection on `mask` (same offsets). One combined pass, leftmost-first, because order bugs are
    // real: blanking `//` before `/* */` ate the `*/` of any block comment containing a URL. Regex literals
    // MUST be blanked (two verified FPs: `/^\}/` early-closed the brace-match and truncated the body before
    // its assertion; `/\/\//` read as a line comment and blanked the assertion). A `/` counts as a regex
    // start only after a punctuator/keyword — the same positions JS itself lexes a regex, so `a / b`
    // division is never eaten (eating a division that wraps the body's only call would be an FP).
    // ONE leftmost-first pass: string | comment | regex-literal must COMPETE, never run in sequence.
    // VERIFIED FP (real hindsight session, directionCheck.test.js): blanking strings FIRST let an apostrophe
    // in ordinary PROSE — `// … metropolitan France's longitude span …` — open a bogus string literal that ran
    // to the next quote far below, swallowing the body's braces and its `await dc.checkRound(...)` call. The
    // block extracted as EMPTY and the test was reported as "asserts nothing" while it plainly asserted.
    // A comment may contain a quote and a string may contain `//` — only leftmost-wins is correct for both.
    const mask = raw.replace(MASKABLE_RE, s => ' '.repeat(s.length));
    TEST_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = TEST_OPEN_RE.exec(raw))) {
      if (mask[m.index] === ' ') continue;                // the `it(` sits in a string/comment, not real code
      let depth = 1, i = TEST_OPEN_RE.lastIndex;          // brace-match forward from the body-opening `{`, on mask
      for (; i < mask.length && depth > 0; i++) { const c = mask[i]; if (c === '{') depth++; else if (c === '}') depth--; }
      if (depth !== 0) continue;                          // unbalanced within the added text → partial/edited block → abstain
      // Span crosses a GAP sentinel → the "block" is added fragments joined across non-added lines, not a
      // fully-added test — its real body lives outside the diff. Checked on RAW (a string blanked in mask
      // could hide the sentinel). Abstain.
      if (raw.slice(m.index, i).includes('\u0000')) continue;
      const body = mask.slice(TEST_OPEN_RE.lastIndex, i - 1).replace(/\bconsole\s*\.\s*\w+\s*\([^)]*\)/g, ' ');
      if (!ACTION_RE.test(body)) {
        out.push({ cls: 1, sev: 'warn', msg: `claimed success, but an added test in ${f.split('/').pop()} makes no call and no assertion — it cannot fail (a test that asserts nothing is not coverage); add an assertion or mark it \`.todo\`` });
        break;                                            // one per file is enough
      }
    }
  }
  return out;
}

/**
 * Pure deterministic Tier-1 analysis. Returns findings[].
 * ctx: { claim, diff, bashCmds:[cmd], results:[{is_error, text}], cwd }
 * OPTIONAL (v1.1.0, transcript-only): bashEvents:[{cmd,seq,background,is_error,text}] (paired+ordered Bash),
 * mutations:[{path,seq,text}] (ordered Edit/Write ledger). When absent (pre-commit, --diff-range, any legacy
 * caller) the checks that need them ABSTAIN — they never fire and never bless on missing data.
 */

// The "last source edit" anchor for the v2 contract's stale-green sensor: the max transcript seq of a
// mutation that touched CODE (not comment/whitespace, not an excluded/non-code path), paths relativized
// against cwd. Extracted from the retired v1 class-1 block so the four gates that killed its verified FPs are
// preserved VERBATIM — comment-only edit, whitespace reformat, scratchpad write, and the absolute-path
// silent-inertness (real transcripts record absolute file_paths; excludedScanPath reads those as out-of-tree,
// so without relativizing, codeMuts is always empty on the one path that supplies mutations). 0 = none.
export function lastCodeEditSeq(mutations = [], cwd = process.cwd()) {
  const normCodeSet = (s, mext) => { const st = { block: false, fence: false };
    return new Set(String(s).split('\n').map(l => splitCodeComment(l, mext, st).code.replace(/\s+/g, '')).filter(Boolean)); };
  const touches = (m) => { const mext = extOf(m.path);
    if (m.added !== undefined || m.removed !== undefined) {
      const a = normCodeSet(m.added ?? '', mext), r = normCodeSet(m.removed ?? '', mext);
      return [...a].some(l => !r.has(l)) || [...r].some(l => !a.has(l)); }
    const mst = { block: false, fence: false };
    return String(m.text).split('\n').some(l => splitCodeComment(l, mext, mst).code.trim() !== ''); };
  const relPath = (p) => { const s = String(p).replace(/\\/g, '/');
    const root = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    return s.toLowerCase().startsWith(root.toLowerCase()) ? s.slice(root.length) : s; };
  return (Array.isArray(mutations) ? mutations : [])
    .map(m => ({ ...m, path: relPath(m.path) }))
    .filter(m => CODE_EXT_RE.test(m.path) && !excludedScanPath(m.path) && touches(m))
    .reduce((mx, m) => Math.max(mx, m.seq || 0), 0);
}
export function analyze({ claim = '', diff = '', gitDiff = null, bashCmds = [], results = [], cwd = process.cwd(), bgPending = false, bashEvents = null, mutations = null }) {
  const findings = [];
  // AG-B/AG-C need REAL -/+ pairing, which only the git diff has. `diff` here is the WIDER scanDiff (git +
  // the Edit/Write tool-ledger + untracked content); the ledger replays a file's unchanged CONTEXT lines as
  // `+` (and never as `-`), so a pre-existing skip/exclusion would falsely read as newly-added. Route the two
  // test-gaming checks to the git-only diff (falls back to `diff` when a caller passes none, e.g. the tests).
  const gDiff = gitDiff != null ? gitDiff : diff;
  const files = changedFiles(diff);
  const added = diff.split('\n').filter(l => l[0] === '+' && !l.startsWith('+++'));   // used by the secret scanner (C1) below

  // AG-B — claimed success but the tests were SKIPPED/EXCLUDED or the coverage gate LOWERED (config/build
  // diff or a skip-flag on the command line), rather than the code fixed. Warn-only. Git-only diff (gDiff).
  findings.push(...testExclusionFindings(claim, gDiff, bashCmds));
  // AG-C — claimed success but an EXISTING test was WEAKENED (strict assertion → loose) or DISABLED. Warn-only.
  findings.push(...testWeakeningFindings(claim, gDiff));
  // Vacuous test — claimed success but an ADDED JS/TS test makes no call/assertion → provably can't fail. Warn-only.
  findings.push(...vacuousTestFindings(claim, gDiff));
  // Anti-gaming: claimed success but the ONLY files changed are tests → the test may have been weakened to
  // pass instead of the code fixed. Warn-only. Re-gated on `claimsSuccess` (the same gate AG-B/AG-C use) now
  // that the v1 class-1 prose scan that used to house it is retired — the v2 contract owns the tests_pass claim.
  if (claimsSuccess(claim)) {
    const testFiles = files.filter(f => TEST_FILE_RE.test(f));
    if (testFiles.length && files.length && files.every(f => TEST_FILE_RE.test(f)))
      findings.push({ cls: 1, sev: 'warn', msg: `claimed pass, but the only files changed are tests (${testFiles.map(f => f.split('/').pop()).join(', ')}) — verify the test wasn't weakened instead of the code fixed` });
  }
  // Mojibake — encoding corruption. NOT claim-gated on purpose: corrupted bytes are corrupted whatever the
  // agent said, and pre-commit/CI pass claim:'' — gating it would make it inert at the very gate it exists
  // for (the real incident entered through a commit). Scans `diff` (the content-scan view, = the staged diff
  // at pre-commit), same reality the secret scanners see.
  findings.push(...mojibakeFindings(diff));

  // async_done — claimed done/clean while the work is actually unfinished. Two grounds: the claim
  // CONTRADICTS itself (says still-running/deferred), OR a background task was launched this session
  // with no completion record (bgPending, from the transcript) — the disk-grounded recall path.
  if (COMPLETION_STAMP_RE.test(claim) && (DEFERRAL_RE.test(claim) || bgPending))
    findings.push({ cls: 'async_done', sev: 'warn', msg: DEFERRAL_RE.test(claim)
      ? 'claimed done/clean while also saying the work is still running/deferred — the deliverable is not produced yet (not "done")'
      : 'claimed done/clean, but a background task launched this session has no completion record — the deliverable is not produced yet (not "done")' });

  // Class 2 — stub / placeholder in NEWLY ADDED lines only. Markers are position-aware (comment/prose only —
  // per file, with block-comment/fence state threaded across that file's added lines); phrase-stubs anywhere.
  let stub = null;
  {
    const byFile = {}; let cf = '';
    for (const l of diff.split('\n')) {
      const h = l.match(/^\+\+\+ b\/(.+)$/);
      if (h) { cf = h[1] === '/dev/null' ? '' : h[1]; continue; }
      if (l[0] === '+' && !l.startsWith('+++') && cf) (byFile[cf] ||= []).push(l.slice(1));
    }
    outer:
    for (const [f, lines] of Object.entries(byFile)) {
      const ext = extOf(f), state = { block: false, fence: false };
      for (const ln of lines) if (lineIsStub(ln, ext, state)) { stub = ln; break outer; }
    }
  }
  if (stub) findings.push({ cls: 2, sev: 'warn', msg: `stub/placeholder in added code: ${stub.trim().slice(0, 60)}` });


  // Class 4 — phantom ref (best-effort, WARN only): a NEW relative import whose target file is
  // absent from the working tree, resolved against the importing file's own directory. Bare/package
  // specifiers are skipped (can't resolve cheaply).
  // NOTE: best-effort + WARN-only — file-existence resolution, not full symbol resolution. Upgrade to
  // proper resolution (a real resolver, or the roadmap LLM layer) only if this misses real phantom refs.
  let curFile = '', curLang = null, curSrc = false, sawC9 = false, c9St = { block: false, fence: false };
  for (const l of diff.split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/);
    if (h) { curFile = h[1] === '/dev/null' ? '' : h[1]; curLang = curFile ? importLang(curFile) : null;
             curSrc = !!curFile && CODE_EXT_RE.test(curFile) && !TEST_FILE_RE.test(curFile);
             c9St = { block: false, fence: false }; continue; }   // reset comment/fence state per file
    if (l[0] !== '+' || l.startsWith('+++') || !curFile) continue;
    if (curLang) {                                                               // Class 4 — phantom ref (import langs only)
      const m = l.match(curLang.re);
      // Real import only if the KEYWORD survives string-blanking at its position — an import-shaped substring
      // INSIDE a string literal (`const d = "+import x from './h'"`, a test fixture) is not a real import.
      if (m && blankStrings(l)[m.index] !== ' ' && !relImportResolves(cwd, curFile, m[1], curLang.suffixes))
        findings.push({ cls: 4, sev: 'warn', msg: `new import may not resolve: ${m[1]} (in ${curFile})` });
    }
    // Class 9 — special-casing the evaluator. Test the CODE portion only (strip comments/strings via
    // splitCodeComment, state threaded per file): a COMMENT that merely MENTIONS the evaluator ("// without
    // GROUNDTRUTH_KEY …") is documentation, not a runtime branch — matching it was the same prose-as-code FP
    // the Class-1 quote-strip fixes (it fired on this project's own AG-A comment).
    // splitCodeComment gives the code and (language-aware) comment portions; state threads across this src
    // file's ADDED lines only (best-effort in diff mode — a block comment closed on an unchanged line can
    // leave state stale, which over-classifies as comment: FP-safe, never a false branch match).
    const { code: c9code, comment: c9comment } = curSrc && !sawC9
      ? splitCodeComment(l.slice(1), extOf(curFile), c9St) : { code: '', comment: '' };
    // Branch-on-evaluator: CODE portion only (a comment naming the env var is not a branch). Suppression
    // directive (groundtruth-disable): the COMMENT portion, anchored to its start (a real directive leads the
    // comment; prose that merely mentions the token — even "#groundtruth-ok" mid-sentence — does not).
    const c9commentBody = (c9comment || '').replace(/^\s*(?:\/\/+|#+|--|\/\*|<!--)?\s*/, '');   // drop a leading comment-opener so the directive can anchor at start
    if (curSrc && !sawC9 && ((c9code && EVAL_CODE_RE.test(c9code)) || EVAL_SUPPRESS_RE.test(c9commentBody))) {
      sawC9 = true;
      findings.push({ cls: 9, sev: 'warn', msg: `non-test source branches on the evaluator/test/CI: ${(c9code || l.slice(1)).trim().slice(0, 60)} — confirm behavior isn't different when audited` });
    }
  }

  // Security (v0.4 §11 / catalog B+C) — deterministic, verdict-grade, diff-scan. Live-schema RLS
  // state + whole-repo secret sweep stay MCP's / gitleaks' lane (§11), not rebuilt here.

  // C1/C2 — a known-format secret in added code (any file). One finding is enough to block.
  for (const l of added) {
    const s = isSecret(l.slice(1));
    if (s) { findings.push({ cls: s.id, sev: s.benign ? 'warn' : 'block',
      msg: s.benign
        ? `${s.label}-shaped token in added code, but it looks like a published example / synthetic placeholder — demoted from block; confirm it isn't a real key`
        : `${s.label} hardcoded in added code` }); break; }
  }

  // SQL checks (B1/B3) scan ONLY added lines in .sql files, with `--` comments STRIPPED — a doc, OR a
  // migration COMMENT that *quotes* `CREATE TABLE` / `USING (true)` to explain a fix (e.g. 068 documenting
  // the bad policies it DROPS), must never trip a schema finding. Confirmed false positive: 068's
  // `USING (true)` lived only in `--` comments + a `DROP POLICY`, yet B3 fired and blocked.
  let sqlAdded = '', cur = '';
  for (const l of diff.split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/);
    if (h) { cur = h[1]; continue; }
    // NOTE: strip line comments only; a `--` inside a string literal is a rare edge we under-flag on.
    // `<mcp-sql>` is the pseudo-file the Stop path mints for SQL run through an MCP DB tool
    // (apply_migration/execute_sql — leaves no file at all). It was captured for EXACTLY these scanners
    // ("an RLS hole or a secret in SQL is otherwise invisible") but `\.sql$` never matched the dotless
    // pseudo-name — so an MCP-applied CREATE TABLE with no RLS produced ZERO findings: an armed check
    // silently inert on the channel it was built for (verified by probe, v1.4.0).
    if (l[0] === '+' && !l.startsWith('+++') && (/\.sql$/i.test(cur) || cur === '<mcp-sql>')) sqlAdded += l.slice(1).replace(/--.*$/, '') + '\n';
  }

  // Blank single-quoted string literals ONCE before every SQL check (B1/B3/B4): quoted text is DATA, not
  // statements. Without this, opening the MCP-SQL channel handed the block tier a false 🔴 — a read-only
  // `execute_sql` SELECT like `WHERE body LIKE '%CREATE TABLE users%'` (querying a migrations/audit table,
  // routine for a Supabase-MCP agent) fired B1, and `note = 'USING (true)'` fired B3 (both reproduced e2e,
  // Fable review). The same root cause gave B4 a literal-`;` FP (`SET css = 'a{x:1;}' WHERE …` split before
  // its WHERE) and a literal-"where" FN (`SET note = 'where needed'` suppressed a real full-table write).
  // `''` escapes are consumed by the alternation; a tautology `USING ('x'='x')` blanks to `USING (''='')`,
  // which B3's LIT class still matches. Residue on an unpaired quote over-consumes → fewer findings, never
  // more (charter-safe).
  sqlAdded = sqlAdded.replace(/'(?:[^']|'')*'/g, "''");
  // B1 — new table created without RLS enabled in the SAME change (doc headline + repo's own rule).
  for (const m of sqlAdded.matchAll(/\bCREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"?public"?\.)?"?([A-Za-z_]\w*)"?/gi)) {
    const tbl = m[1];
    // RLS counts as present only when an ALTER for THIS table enables it (no `;` between). Under-flag, never over.
    const rlsOn = new RegExp(`ALTER TABLE[^;]*\\b${tbl}\\b[^;]*ENABLE ROW LEVEL SECURITY`, 'i').test(sqlAdded);
    if (!rlsOn) findings.push({ cls: 'B1', sev: 'block', msg: `new table "${tbl}" created without ENABLE ROW LEVEL SECURITY in the same change` });
  }

  // B3 — permissive policy. A policy whose predicate filters NOTHING means the anon/publishable key
  // reads (USING) or writes (WITH CHECK) EVERY row. Enumerating each tautology form (`true`, `1=1`,
  // `1<2`, `'x'='x'`, `NOT false`, …) is the trap the agent just walked through. Match the CLASS instead:
  // a predicate that is ONLY literals + operators (no column / `auth.uid()` / identifier) does no row
  // scoping by construction. `auth.uid() = user_id` has an identifier → not flagged; `1 < 2` does not.
  // (Cover WITH CHECK too — that gate had let anon WRITES through.) Residual: a compound predicate that
  // mixes a real column with a tautology (`user_id = user_id OR true`) still needs the semantic layer.
  const LIT = `(?:true|false|[0-9]+|'[^']*')`;
  const permissive = new RegExp(`\\b(?:USING|WITH\\s+CHECK)\\s*\\(+\\s*(?:true|not\\s+false|${LIT}\\s*(?:=|<|>|<=|>=|<>)\\s*${LIT})`, 'i');
  if (permissive.test(sqlAdded))
    findings.push({ cls: 'B3', sev: 'block', msg: 'permissive policy (USING/WITH CHECK with a constant predicate — true / 1=1 / 1<2 / …) added — anon-readable or -writable when granted TO public/anon; confirm the table exposes no PII (auth tokens, names, emails)' });
  // H8 — the durable fix is to STOP regexing the predicate (you can't enumerate every tautology — `((1=1))`,
  // `true OR false`, …). Gate on the GRANT instead: ANY policy TO anon/public is predicate-agnostic
  // surfaced for confirmation (warn — legit row-scoped policies exist, so not an auto-block), because the
  // body could be a wrapped/compound constant the regex above will always miss.
  else if (/\bCREATE\s+POLICY\b[\s\S]{0,400}?\bTO\s+(?:anon|public)\b/i.test(sqlAdded))
    findings.push({ cls: 'B3', sev: 'warn', msg: 'policy granted TO anon/public — confirm it ROW-SCOPES (USING auth.uid()/tenant_id, not a constant or compound tautology) and the table holds no PII; the predicate cannot be verified by pattern' });

  // B4 — UPDATE/DELETE with no WHERE (WARN only, by request and by nature: a full-table write is
  // occasionally intentional — a migration backfilling a column — but far more often a scope bug that
  // rewrites or empties the whole table). Precision scope, per the FP-fatal invariant:
  //   • only a COMPLETE statement fires — its terminating `;` must be visible in the added text. An added
  //     `UPDATE t SET x = 1` whose WHERE lives on the next, UNCHANGED line has no `;` in view → the tail
  //     fragment after the last `;` is dropped and the check ABSTAINS rather than guessing.
  //   • the statement HEAD must be UPDATE / DELETE FROM — a `-- comment`, a `/* block */` (stripped
  //     below), a CREATE POLICY … FOR DELETE, or SQL quoted inside another statement never anchors.
  //   • any \bWHERE\b before the terminator suppresses (a subquery-only WHERE also suppresses — an FN we
  //     accept over parsing SQL; warn-tier).
  // Documented ceilings: a CTE head (`WITH … UPDATE`) abstains; in a $$ function body the FIRST statement's
  // fragment starts with CREATE and abstains, but SUBSEQUENT ones are graded (defensible — a full-table
  // write when the function runs is exactly warn's question); statements split across added hunks with the
  // `;` out of view abstain.
  for (const stmt of sqlAdded.replace(/\/\*[\s\S]*?\*\//g, ' ').split(';').slice(0, -1)) {
    const head = stmt.trimStart();
    if (!/^(?:update|delete\s+from)\b/i.test(head)) continue;
    // A WHERE suppresses only if it actually SCOPES rows. A TAUTOLOGY predicate — `WHERE 1=1`, `WHERE
    // 0=0 OR 1=1`, `WHERE true`, `WHERE 'x'='x'` (already blanked to ''='') — filters nothing and is a
    // full-table write in disguise; same predicate class B3 catches on policies: only literals +
    // operators + boolean keywords, NO identifier doing row scoping. Any real identifier (`id = 3`,
    // `auth.uid()`, `EXISTS (SELECT …)`) → scoped → suppressed; the trailing RETURNING clause is not
    // part of the predicate and is stripped before the test. The identifier class is `\p{L}` (ANY
    // letter), not A-Za-z — Postgres/MySQL accept unquoted non-ASCII identifiers, and an ASCII-only
    // test read `WHERE имя = 'x'` / `WHERE 名前 = 'x'` as "filters nothing" on a correctly scoped
    // DELETE (reproduced FP, Fable review). `\$\d` counts too: a bound parameter (`WHERE $1`) scopes.
    const wm = /\bwhere\b([\s\S]*)$/i.exec(stmt);
    const scopes = wm && /[\p{L}_]|\$\d/u.test(
      wm[1].replace(/\breturning\b[\s\S]*$/i, ' ').replace(/\b(?:true|false|null|and|or|not)\b/gi, ' '));
    if (scopes) continue;
    findings.push({ cls: 'B4', sev: 'warn',
      msg: `UPDATE/DELETE ${wm ? 'whose WHERE is a tautology (filters nothing)' : 'with no WHERE'} — this touches EVERY row (${head.replace(/\s+/g, ' ').slice(0, 60)}…); confirm a full-table write is intended` });
  }

  return findings;
}

/**
 * Audit mode (v0.2 §3/§5): scan ONE file's raw content for deterministic debt — classes 2 (stub/
 * placeholder/TODO) and 4 (unresolved relative import). No claim, no intent, no rules → inventory,
 * not a verdict. Returns findings tagged with {file, line}. Exported for the self-check.
 */
export function scanContent(relPath, text, cwd = process.cwd()) {
  const out = [];
  const lang = importLang(relPath);                      // null for a language whose imports we don't resolve
  const ext = extOf(relPath), state = { block: false, fence: false };   // full-file → exact block-comment/fence state
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (lineIsStub(line, ext, state))
      out.push({ cls: 2, sev: 'warn', file: relPath, line: n, msg: line.trim().slice(0, 80) });
    if (!lang) return;                                    // abstain on phantom-refs for unsupported languages
    const m = line.match(lang.re);
    if (m && blankStrings(line)[m.index] !== ' ' && !relImportResolves(cwd, relPath, m[1], lang.suffixes))
      out.push({ cls: 4, sev: 'warn', file: relPath, line: n, msg: `unresolved import ${m[1]}` });
  });
  return out;
}

/** Walk tracked source files and scan each — the standalone `--audit` debt inventory. */
/**
 * Collect the on-disk inputs for agentFindings: every `**\/.claude/agents/*.md` plus the rule docs
 * that may reference one. Fs/git wrapper around the PURE core (which is where all the logic and tests live).
 * `--others --exclude-standard` includes UNTRACKED files: a brand-new, not-yet-committed agent is the single
 * most likely place for a broken one to live (the tracked-only draft was blind to exactly that — verified
 * by sandbox probe, v1.3.1 review), while --exclude-standard keeps gitignored junk out. Submodule contents
 * never appear in either listing, so an independent inner project can't false-fire the location check.
 * Fail-open: any git/read error yields [] — a broken read must never break a turn.
 */
function collectAgents(cwd, git) {
  let tracked = [];
  try { tracked = git('ls-files --cached --others --exclude-standard').split('\n').filter(Boolean); } catch { return { agents: [], docs: [] }; }
  const rd = (f) => { try { return readFileSync(join(cwd, f), 'utf8'); } catch { return null; } };
  const agents = [];
  for (const f of tracked.filter(f => /(^|\/)\.claude\/agents\/[^/]+\.md$/.test(f))) {
    const src = rd(f); if (src !== null) agents.push({ rel: f, src });
  }
  const docs = [];
  for (const f of tracked.filter(f => RULE_SRC_RE.test(f))) {
    const src = rd(f); if (src !== null) docs.push({ rel: f, src });
  }
  return { agents, docs };
}

function auditRepo(cwd, git) {
  const files = git('ls-files').split('\n').filter(f => CODE_EXT_RE.test(f));
  const findings = [];
  // Agent integrity is a WHOLE-REPO property, never a diff one: the 16 invisible agents were long-committed
  // and would never appear in any diff. So it belongs here (and at SessionStart), not in analyze().
  { const { agents, docs } = collectAgents(cwd, git); findings.push(...agentFindings(agents, docs)); }
  const tty = process.stderr.isTTY;             // progress only on a terminal; keeps piped output clean
  files.forEach((f, i) => {
    if (tty && (i % 20 === 0 || i === files.length - 1))
      process.stderr.write(`\r  scanning ${i + 1}/${files.length} files…`);
    let text;
    try { text = readFileSync(join(cwd, f), 'utf8'); } catch { return; }
    if (text.length > 500_000) return;          // skip generated/minified blobs
    findings.push(...scanContent(f, text, cwd));
  });
  if (tty) process.stderr.write('\r' + ' '.repeat(36) + '\r'); // clear the progress line
  return findings;
}

/** Stable-ish key for a debt finding (file + content, line-independent). */
function debtKey(f) { return `${f.file}::${f.msg}`; }

/**
 * §5 baseline attribution: split current debt findings into `introduced` (new since the session
 * baseline) vs `preExisting` (already there at session start — note, don't blame). Pure + tested.
 */
export function attributeDebt(baselineKeys, currentFindings) {
  const base = baselineKeys instanceof Set ? baselineKeys : new Set(baselineKeys || []);
  const introduced = [], preExisting = [];
  for (const f of currentFindings) (base.has(debtKey(f)) ? preExisting : introduced).push(f);
  return { introduced, preExisting };
}

// ── §10 compiled rules — prose rules (CLAUDE.md / skills) turned into deterministic predicates ──
// The rule-compiler agent (Stop hook, when rules change) writes .claude/groundtruth/compiled-rules.json:
//   [{ id, source, kind:'forbid_path'|'forbid_in_added', file_re, line_re?, unless_re?, severity?, message }]
// Auto-compiled rules default to WARN (a compiler misread must never false-BLOCK); a human bumps a
// trusted one to severity:'block' after reviewing the file. Evaluator is pure + tested.
export function loadCompiledRules(cwd) {
  try {
    const j = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', 'compiled-rules.json'), 'utf8'));
    return Array.isArray(j) ? j : (j.rules || []);
  } catch { return []; }
}

// Permission gate visibility: how many CLEAN (armable) proposed rules a human hasn't approved yet.
// Surfaced in the verdict card so the approval step is discoverable even where the init stderr notice
// doesn't render (VS Code). Counts only 'armable' — review-flagged candidates aren't nudged, they wait.
export function pendingApprovals(cwd) {
  let proposed = [], approved = [];
  try { proposed = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', 'proposed-rules.json'), 'utf8')); } catch {}
  try { approved = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', 'compiled-rules.json'), 'utf8')); } catch {}
  const have = new Set((Array.isArray(approved) ? approved : approved.rules || []).map(r => r.id));
  return (Array.isArray(proposed) ? proposed : []).filter(r => r.status === 'armable' && !have.has(r.id)).length;
}

// A rule regex may be hand-authored (seed-rules.json) or grounded via PCRE `git grep -P`, so it can carry
// a PCRE/Python LEADING inline-flag group — `(?i)` (redundant here: we always apply `i`), `(?s)`, `(?m)`.
// JS `RegExp` rejects inline groups, so such a pattern used to throw and the rule was SILENTLY skipped —
// an armed rule doing nothing, the exact false-confidence Groundtruth exists to catch (and the grounder
// used `-P`, which DOES accept `(?i)`, so it passed grounding as 'armable' yet never fired). Normalize a
// leading flag group into real JS flags, then compile; throws only on a genuinely malformed pattern.
export function compileRuleRe(pattern) {
  let src = String(pattern), flags = 'i';
  const m = src.match(/^\(\?([a-zA-Z]+)\)/);
  if (m) { src = src.slice(m[0].length); if (m[1].includes('m')) flags += 'm'; if (m[1].includes('s')) flags += 's'; }
  // Member-access-safe boundary for CALL-forbidding rules (the `$eval` FP). A rule like `\beval\s*\(` is
  // meant to forbid the GLOBAL `eval()` — but `\b` treats `.`/`$` as a word boundary, so it over-matches a
  // METHOD call `x.eval()` / Playwright's `page.$eval()` (a different function). Upgrade a LEADING `\b`
  // before an identifier to a lookbehind that also excludes `.`/`$`/word — but ONLY when the pattern forbids
  // a CALL (an escaped `\(` is present), so an identifier/column rule like `\bsignup_date\b` (which SHOULD
  // still match `row.signup_date`) is left untouched. Applied at the shared normalizer so it fixes seed,
  // extracted, and already-armed rules at runtime with no re-arm. `(?<![\w$.])` == the tokenizer's real
  // "start of a standalone identifier".
  if (/^\\b[A-Za-z_$]/.test(src) && /\\\(/.test(src)) src = src.replace(/^\\b/, '(?<![\\w$.])');
  return new RegExp(src, flags);
}

export function runCompiledRules(diff, rules) {
  const out = [];
  if (!rules || !rules.length) return out;
  // added lines grouped by file
  const byFile = {}; let cur = '';
  for (const l of diff.split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/);
    if (h) { cur = h[1] === '/dev/null' ? '' : h[1]; continue; }
    if (l[0] === '+' && !l.startsWith('+++') && cur) (byFile[cur] ||= []).push(l.slice(1));
  }
  const files = Object.keys(byFile);
  for (const r of rules) {
    let fre, lre, ure;
    // A regex that won't compile can enforce NOTHING — surface it LOUDLY as inert, never silently skip:
    // an armed-but-dead rule is false confidence (matches the vacuous-unless_re guard below). Warn, not
    // block — a broken rule shouldn't halt the turn, but it must be visible so it gets fixed.
    try { fre = compileRuleRe(r.file_re); lre = r.line_re && compileRuleRe(r.line_re); ure = r.unless_re && compileRuleRe(r.unless_re); }
    catch (e) { out.push({ cls: 'R', sev: 'warn', rule: r.id, msg: `rule ${r.id} is INERT — its regex does not compile (${String(e.message).slice(0, 60)}); fix its file_re/line_re or it enforces nothing` }); continue; }
    const sev = r.severity === 'block' ? 'block' : 'warn';   // auto-compiled = warn unless a human promoted it
    // Provenance: a rule COMPILED FROM a doc must never fire on that same doc — the declaring file is
    // mention-context by construction (`ARCHITECTURE.md: never eval` shouldn't flag ARCHITECTURE.md). Zero
    // hand-maintenance: the source is recorded on the rule. (Seed rules name no declaring doc → no skip.)
    const declBase = (String(r.source || '').match(/extracted from ([^:]+):/) || [])[1]?.split('/').pop();
    // A rule matching inside a COMMENT is a MENTION, not a use. R3 (v0.8) applied that only to CALL rules
    // (`\beval\s*\(`), on the theory that a non-call rule might target comments — which left every
    // IDENTIFIER/MEMBER rule scanning prose. VERIFIED FP (real hindsight session): a rule forbidding
    // `import.meta` (no call paren → not a "call rule") fired on the very COMMENT that EXPLAINS the rule —
    // `// never use import.meta here (CJS)` — while the code contained none. The same prose-as-code self-match
    // R3 fixed for calls, still live for everything else.
    // INVERT THE DEFAULT: every rule tests the CODE portion, UNLESS it plainly TARGETS comments — a lint /
    // suppression directive (`@ts-ignore`, `eslint-disable`, `noqa`) or a TODO-class marker, the only kinds
    // that must see comment text to work at all. Strictly fewer FPs, and no such rule goes inert: a
    // comment-targeting rule still gets the raw line.
    // Classified by what the rule's OWN regex MATCHES — probe strings of real directive/marker text — never
    // by substrings of its source. The first cut classified on source substrings (/@|ignore|disable|…/),
    // which sent every decorator rule (`@Injectable\s*\(`), npm-scope import rule (`from '@old-scope/`), and
    // identifier rule containing ignore/todo/suppress (`\bignoreErrors\s*\(`, `\btodoList\b`,
    // `suppressWarnings\s*\(`) down the raw-line path — re-opening for those rules the exact prose-comment FP
    // this inversion ships to close (all five re-fired, verified by probe in the v1.3.1 review). A probe
    // can't misfire that way: `@Injectable\(` matches no directive text. Probes are spelled as they appear
    // IN comments (`// TODO`, `# noqa`) so a comment-anchored rule (`//\s*TODO`) classifies too, and they
    // carry no ordinary code words a code rule could accidentally match.
    const COMMENT_PROBES = ['// @ts-ignore', '// @ts-expect-error', '// @ts-nocheck',
      '/* eslint-disable */', '// eslint-disable-next-line', '// eslint-disable-line', '// prettier-ignore',
      '# noqa', '# type: ignore', '# pylint: disable', '/* istanbul ignore next */', '// NOSONAR', '//nolint',
      '// TODO', '# TODO', '// FIXME', '# FIXME', '// XXX', '// HACK', '# HACK'];
    const commentRule = !!lre && COMMENT_PROBES.some(p => lre.test(p));
    const skipDecl = (f) => declBase && f.split('/').pop() === declBase;
    if (r.kind === 'forbid_path') {
      const hit = files.find(f => fre.test(f) && !skipDecl(f));
      if (hit) out.push({ cls: 'R', sev, rule: r.id, msg: `${r.message || r.id} (${hit})` });
    } else if (r.kind === 'forbid_in_added' && lre) {
      // B1 — an unless_re that matches EVERYTHING (e.g. `.*`) suppresses every hit, so the rule can never
      // fire: an "armed" inert rule that gives false confidence. Surface it instead of silently passing.
      if (ure && ure.test('')) { out.push({ cls: 'R', sev: 'warn', rule: r.id, msg: `rule ${r.id} is INERT — its unless_re matches every line, so it can never fire (vacuous or neutered)` }); continue; }
      for (const f of files) {
        if (!fre.test(f) || skipDecl(f)) continue;
        const ext = extOf(f), st = { block: false, fence: false };
        // matchable view: CODE ONLY by default (comments stripped, state threaded in line order); a rule that
        // targets comments (a lint/suppression directive, a TODO marker) sees the raw line — see commentRule.
        const view = commentRule ? byFile[f] : byFile[f].map(x => splitCodeComment(x, ext, st).code);
        const idx = view.findIndex(x => lre.test(x));
        if (idx === -1) continue;
        const bad = byFile[f][idx];                            // report the ORIGINAL line, not the stripped view
        // B2 — the rule WOULD fire, but an unless_re token on a this-turn added line suppresses it. The
        // escape hatch is legit, but adding it alongside a violation must be visible, not silent (byFile =
        // this turn's added lines, so any suppressing token here was introduced this turn).
        if (ure && byFile[f].some(x => ure.test(x))) {
          out.push({ cls: 'R', sev: 'warn', rule: r.id, msg: `rule ${r.id} suppressed by an inline exemption added this turn (${f}) — confirm it's a real exception, not a dodge` }); break;
        }
        out.push({ cls: 'R', sev, rule: r.id, msg: `${r.message || r.id}: ${bad.trim().slice(0, 60)} (${f})` }); break;
      }
    }
  }
  return out;
}

/** Render the audit inventory (findings, not a verdict). */
function renderAudit(findings) {
  const group = (cls) => findings.filter(f => f.cls === cls);
  const section = (title, list) => [
    `  ${title}: ${list.length}`,
    ...list.slice(0, 25).map(f => `    🟡 ${f.file}:${f.line}  ${f.msg}`),
    ...(list.length > 25 ? [`    … +${list.length - 25} more`] : []),
  ];
  return [
    `GROUNDTRUTH — audit · ${findings.length} finding${findings.length === 1 ? '' : 's'} (debt inventory, not a verdict)`,
    '',
    ...section('Class 2 · stub / placeholder / TODO', group(2)),
    '',
    ...section('Class 4 · phantom / unresolved import', group(4)),
    ...(group('ENV').length ? [
      '',
      `  Security · env files exposed: ${group('ENV').length}`,
      ...group('ENV').map(f => `    ${f.sev === 'block' ? '🔴' : '🟡'} ${f.msg}`),
    ] : []),
    // Agent findings carry msg only (no file:line) — the generic section() would render "undefined:undefined".
    // v1.3.1 review: the first wiring counted these in the header but never printed them — a finding the
    // header admits to and the body hides is exactly the silent-loss this tool exists to prevent.
    ...(group('agent').length ? [
      '',
      `  Agents · cannot load (silently inert): ${group('agent').length}`,
      ...group('agent').map(f => `    🟡 ${f.msg}`),
    ] : []),
  ].join('\n');
}

/**
 * Extract { intent, bashCmds, results } from a transcript JSONL string.
 * intent = first non-sidechain user text (harness noise stripped); bashCmds =
 * Bash tool_use commands; results = tool_result {is_error, text}.
 * v1.1.0 additive: bashEvents = ORDERED Bash calls PAIRED with their results
 * ({cmd, seq, background, is_error, text} — is_error:null when unpaired), and
 * mutations = ordered Edit/Write/MultiEdit {path, seq, text(changed lines)}.
 */
export function parseTranscript(jsonlText, { includeSidechain = false } = {}) {
  const allEntries = (jsonlText || '').split('\n')
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
  const entries = allEntries
    // Default OFF: on the MAIN transcript a sidechain entry is a subagent's — its "user" turns are the
    // orchestrator's task prompts, not human asks, and letting them into `asks` mints phantom deliverables.
    // But at SubagentStop the payload's transcript_path is the subagent's OWN file, where EVERY entry is
    // isSidechain:true — this filter deleted 100% of the subagent's evidence while its claim survived (a
    // payload field), so every honest test-running subagent hit `!ran` ("no test/build command ran"): a
    // structural FP, v1.1.1. That one caller opts in; every other caller keeps the filter.
    .filter(e => includeSidechain || e.isSidechain !== true);
  // Bash commands the FILTERED sidechains ran (a Task subagent's, harness-recorded and unfakeable). We don't
  // fold them into the main evidence (they're a delegated run, and the orchestrator's own path can't see their
  // output), but the contract uses them to ABSTAIN rather than block: an orchestrator declaring `tests_pass`
  // after a subagent genuinely ran the tests should not get a block-tier CA "no such command ran". (Fable adv FP-10.)
  const sidechainCmds = [];
  if (!includeSidechain) {
    for (const e of allEntries) {
      if (e.isSidechain !== true) continue;
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') sidechainCmds.push(b.input.command);
    }
  }

  const textOf = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  };

  let intent = '';
  const asks = [];   // MEMORY: the cumulative contract — every real user ask this session, not just #1.
  const commandsInvoked = new Set();   // unforgeable human ratification — a slash command the agent can't author
  const commandInvocations = [];       // ORDERED (with dups) — a transcript POSITION so tamper ratification is
                                       // "invoked THIS turn" (fresh past the snapshot mark), not "name ever seen"
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const raw = textOf(e.message?.content);
    // A slash-command invocation is a HUMAN action the agent cannot fake (it can't type `/x` into the
    // conversation). Record it BEFORE any skip — it's not an "ask", but it's the ratification signal the
    // tamper meta-check trusts (a referee-state write is legit only if the matching command was run).
    const cm = raw.match(/<command-name>\/?([\w:.-]+)<\/command-name>/);
    // Record BOTH the raw name and its bare suffix — a plugin command is logged namespaced + slashed
    // (`/groundtruth:groundtruth-rules`), but ratifiedBy is the bare `groundtruth-rules`. Without the
    // suffix, arming rules via the sanctioned `/groundtruth-rules` falsely trips the tamper check on its
    // OWN compiled-rules.json write.
    if (cm) { commandsInvoked.add(cm[1]); commandsInvoked.add(cm[1].split(':').pop()); commandInvocations.push(cm[1].split(':').pop()); }
    // POSITIVE structural signal (grounded in the transcript schema, not a text guess): a genuine typed
    // prompt carries promptSource/permissionMode and NONE of the harness's injection markers. Tool
    // results (toolUseResult), meta/compaction context (isMeta/isCompactSummary/isVisibleInTranscriptOnly),
    // and hook feedback re-injected as a user turn (isMeta — incl. THIS tool's own Stop output) all carry
    // one. Excluding on the marker catches a NEW injection type too, not just the text patterns we know.
    if (e.isMeta === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true || e.toolUseResult !== undefined) continue;
    // Text backstop for injections delivered without a structural marker (manufactured the circular
    // "tasks.json" / "Stop hook feedback" / "<task-notification>" phantom tasks):
    //   • slash/local-command wrappers + caveat boilerplate
    //   • background task-completion notices (<task-notification>/<task-id>/<tool-use-id>)
    //   • hook feedback echoed back as a turn — INCLUDING this tool's own Stop output (self-reference)
    if (/<(command-(name|message|args)\b|local-command-)/.test(raw)) continue;
    if (/<task-notification|<task-id>|<tool-use-id>/.test(raw)) continue;
    if (/^\s*Stop hook feedback\b|Agent hook condition (?:was )?not met|Groundtruth[^\n]{0,40}blocked this stop/i.test(raw)) continue;
    const t = raw
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
      .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '')
      .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!intent) intent = t;   // first real ask — kept for back-compat (single-turn completeness)
    asks.push(t);              // accumulate ALL asks so the contract spans related messages, not one
  }

  const bashCmds = [], mcpCmds = [], results = [], toolDiffParts = [], mcpSqlParts = [];
  // v1.1.0 — PAIRED + ORDERED evidence, additive to the flat arrays above (which every existing caller keeps).
  // The flat shape threw away exactly what the artifact-grounded Class-1 checks need:
  //   • WHICH command a result belongs to — `tool_use.id` ↔ `tool_result.tool_use_id`. Without the pairing,
  //     `npm test` exiting 1 whose output carries no TEST_FAIL_RE-recognizable string ("Killed", a bare
  //     "command failed with exit code 1") was blessed as green: is_error was CAPTURED below and read by nothing.
  //   • WHERE a Bash call sits relative to Edit/Write/MultiEdit — without an interleaved order, a green run
  //     that PREDATES the final source edit still read as "tests ran, none failed" (the stale-green hole).
  // `seq` is a monotonic position over ALL tool_use blocks in transcript order. The transcript is the harness's
  // own append-ordered record — one of the two inputs the agent can't author — so the ordering is trustworthy.
  const bashEvents = [], mutations = [], byToolId = new Map();
  const assistantTexts = [];   // every assistant message's text, in order — feeds the multi-turn deferral ledger
  let seq = 0;
  let bgLaunched = 0, bgDone = 0;                  // background tasks launched vs completed (async_done evidence)
  for (const e of entries) {
    const content = e.message?.content;
    // Each ASSISTANT message's text (newline-preserving) — so the Stop hook can recover the claims block from
    // EVERY past turn this session, not just the current one, and reconstruct the still-open deferral set
    // (spec §6 multi-turn tracking, anchored on the transcript rather than a forgeable ledger).
    if (e.type === 'assistant') { const at = textOf(content); if (at) assistantTexts.push(at); }
    // completion notices arrive as text ("<task-notification> … <status>completed")
    const asText = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(b => b?.type === 'text' ? (b.text || '') : '').join(' ') : '';
    if (/task-notification/i.test(asText) && /\b(completed|status>\s*completed|finished)\b/i.test(asText)) bgDone++;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') seq++;           // count EVERY tool_use (Read/Grep too) — relative order is global
      if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.command) {
        bashCmds.push(b.input.command);
        // is_error:null = "no result paired" (in-flight, or a transcript without ids). A consumer MUST treat
        // null as abstain, never as success — missing data must not bless a green (charter: fail-loud beats
        // a silent false pass, and here the loud path is the still-running flat sensors, not a guess).
        const ev = { cmd: b.input.command, seq, background: b.input.run_in_background === true, is_error: null, text: '' };
        bashEvents.push(ev);
        if (b.id) byToolId.set(b.id, ev);
      }
      if (b?.type === 'tool_use' && (b.name === 'Workflow'
        || ((b.name === 'Bash' || b.name === 'Task' || b.name === 'Agent') && b.input?.run_in_background === true))) bgLaunched++;
      // no-git "Diff Ledger": reconstruct added lines from the agent's Edit/Write tool calls (the
      // HARNESS logged these — unfakeable, not the agent's self-report). Used when git is absent/empty.
      if (b?.type === 'tool_use' && b.input?.file_path && (b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit')) {
        const added = b.name === 'Write' ? String(b.input.content || '')
          : b.name === 'Edit' ? String(b.input.new_string || '')
          : (b.input.edits || []).map(x => String(x.new_string || '')).join('\n');
        if (added) toolDiffParts.push(`+++ b/${b.input.file_path}\n` + added.split('\n').map(l => '+' + l).join('\n'));
        // Ordered mutation ledger (stale-green evidence). `text` = the SET-DIFF of new-vs-old lines, not the
        // raw new_string: an Edit carries unchanged CODE context lines (old_string needs them for uniqueness),
        // so a comment-only tweak after a green run would otherwise read as "code touched" via its untouched
        // context → a stale-green FP on a harmless comment edit. The old side is included so a pure DELETION
        // of code (new_string empty/shorter) still counts — deleting code invalidates a green just as adding
        // does. Pushed OUTSIDE the `if (added)` guard for exactly that deletion case.
        const removed = b.name === 'Edit' ? String(b.input.old_string || '')
          : b.name === 'MultiEdit' ? (b.input.edits || []).map(x => String(x.old_string || '')).join('\n') : '';
        const aL = added.split('\n'), rL = removed.split('\n');
        const aSet = new Set(aL), rSet = new Set(rL);
        // v1.1.1: carry the raw added/removed SIDES too. The merged raw-line set-diff can't distinguish an
        // inert edit from a real one when a single line changes only outside its code — `total++; // count`
        // → `total++; // the count` differs raw on BOTH sides, so stale-green fired on a comment tweak that
        // rode a code-carrying line (verified FP; same for whitespace reformats). analyze's mutTouchesCode
        // needs the two sides separately to compare their NORMALIZED CODE portions instead.
        mutations.push({ path: b.input.file_path, seq, added, removed,
          text: [...aL.filter(l => !rSet.has(l)), ...rL.filter(l => !aSet.has(l))].join('\n') });
      }
      // MCP DB writes leave NO file and NO git diff — a migration/SQL runs straight against the database,
      // so an RLS hole or a secret in SQL is otherwise invisible. Capture the SQL/query args from any
      // mcp__* execute_sql / apply_migration tool_use so the security scanners (B1/B3/secret) still see it.
      if (b?.type === 'tool_use' && /^mcp__/.test(b.name || '') && /(execute_sql|apply_migration|query|sql)/i.test(b.name)) {
        const sql = b.input?.query || b.input?.sql || b.input?.statement || '';
        if (sql) mcpSqlParts.push(String(sql));
        // also a COMMAND-shaped string so runProcedures (forbid_present "never run a prod migration")
        // sees the MCP channel, not just Bash — the tool name + SQL is the command the agent "ran".
        mcpCmds.push(`${b.name} ${sql}`.trim());
      }
      if (b?.type === 'tool_result') {
        results.push({ is_error: b.is_error === true, text: JSON.stringify(b.content || '') });
        // Pair the result back to its Bash call. Unmatched ids (a subagent's, a non-Bash tool's) just miss the
        // map — the flat `results` above keeps them for the legacy substring sensors.
        const ev = b.tool_use_id != null ? byToolId.get(b.tool_use_id) : undefined;
        // DECODE the paired run output (not JSON.stringify): the contract's failure-substring sensor reads
        // `ev.text` and matches LINE-ANCHORED runner banners (jest `FAIL src/x`, pytest `FAILED …`, `not ok`).
        // Stringified, real newlines become the 2 chars `\n` and every line-start banner is preceded by `"`/`n`
        // → the whole banner tier was silently INERT on the production path (unit tests pass raw text, so they
        // never saw it). Count-anchored alternatives ("Tests: 3 failed") survive either way. (Fable adv FN-4.)
        if (ev) { ev.is_error = b.is_error === true; ev.text = textOf(b.content); }
      }
    }
  }
  return { intent, asks, commandsInvoked, commandInvocations, bashCmds, mcpCmds, results, bashEvents, mutations, sidechainCmds, assistantTexts, bgPending: bgLaunched > bgDone, toolDiff: toolDiffParts.join('\n'), mcpSql: mcpSqlParts.join('\n') };
}

/**
 * Contract memory — the OPEN-LOOPS half of "did it do everything asked across related messages".
 * Deterministic, grounded: an ask whose named deliverable (a file/path/symbol it mentions) never
 * appears in the cumulative diff is still OPEN. Asks that name no concrete deliverable are not
 * gradeable here (left to the semantic layer) and are NOT surfaced — abstain over false-nag.
 * This is the SCAFFOLD: the quality of ask→delivery matching is the LLM layer still to come.
 */
// Does a named deliverable token ground in the diff text? Filename-like tokens (a path ending in a known
// source extension) match CASE-INSENSITIVELY — a human writes `schema.md` for the file the repo calls
// `SCHEMA.md`, and the case-sensitive miss was a false open-loop / silent-no-op (the whole reason this
// exists). Symbols/identifiers stay case-sensitive: code is case-sensitive, so `fooBar` ≠ `foobar`.
const FILENAME_TOKEN_RE = new RegExp('[\\w/-]+\\.(?:' + SRC_EXT + ')$', 'i');
// A SYMBOL deliverable grounds only when it lands in CODE, not in a `// TODO: handleUpload` comment mention
// (the comment-vector cheap-close — the cheapest green is to name the symbol in a comment). A FILENAME grounds
// via the diff's `+++` headers (never a comment), so it uses the full `changed`. `code` = added lines with
// comments stripped (built by codeOnlyAdded); when absent, falls back to `changed` (back-compat).
function grounds(token, changed, changedLower, code) {
  return FILENAME_TOKEN_RE.test(token)
    ? (changedLower ?? changed.toLowerCase()).includes(token.toLowerCase())
    : (code ?? changed).includes(token);
}
// Added lines with comments stripped, per file (block-comment/fence state threaded) — the CODE reality a
// symbol deliverable must appear in to count as delivered.
function codeOnlyAdded(diff) {
  let out = '', cf = '', ext = '', st = { block: false, fence: false };
  for (const l of String(diff).split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/);
    if (h) { cf = h[1] === '/dev/null' ? '' : h[1]; ext = extOf(cf); st = { block: false, fence: false }; continue; }
    if (l[0] === '+' && !l.startsWith('+++') && cf) out += splitCodeComment(l.slice(1), ext, st).code + '\n';
  }
  return out;
}

// ── §11 Referee-state tamper-evidence — the category above gaming a single check ──
// The whole security model in one sentence: the verdict is only as trustworthy as the LEAST-protected
// input the hook reads. The agent doesn't have to beat a check if it can edit what the check reads — its
// own rulebook (compiled-rules.json), its block switch (config.json), its ledger (tasks.json). These are
// EXEMPTION-GRANTING state, and exemption-granting state must not be agent-writable as ground truth.
// Where we can, authority is relocated out of reach (deferrals → typed turn; block → env). Where state
// still lives on agent-writable disk, this is the tripwire: if THIS turn's diff rewrote referee state,
// emit a finding that the rewrite itself cannot suppress. Two anchors make it un-cuttable:
//   • ratification is the UNFORGEABLE human signal — a slash-command turn the agent can't author. A write
//     is legit only if the matching command (/groundtruth-rules, /groundtruth-block) was actually run.
//   • severity is anchored to ENV block authority, NEVER to config.json — the file does not get a vote on
//     its own tampering. So `config.json {block:false}` written this turn can't quiet its own alarm.
const REFEREE_FILES = [
  { re: /(^|\/)\.claude\/groundtruth\/compiled-rules\.json$/, ratifiedBy: ['groundtruth-rules', 'groundtruth-setup'], what: 'compiled-rules.json (the armed rule set)' },
  { re: /(^|\/)\.claude\/groundtruth\/config\.json$/,         ratifiedBy: 'groundtruth-block', what: 'config.json (block-mode switch)' },
  { re: /(^|\/)\.claude\/groundtruth\/[^/]*\.tasks\.json$/,   ratifiedBy: null,                what: 'the task ledger (tasks.json)' },
  { re: /(^|\/)\.claude\/groundtruth\/[^/]*\.baseline\.json$/, ratifiedBy: null,               what: 'the session baseline (baseline.json — deleting it blinds diffing to HEAD)' },
  { re: /(^|\/)\.claude\/groundtruth\/[^/]*\.refsnapshot\.json$/, ratifiedBy: null,            what: 'the referee integrity snapshot (refsnapshot.json — editing it forges the tamper baseline)' },
];
// A referee-file write is ratified if ANY of its accepting slash-commands ran this turn (a human turn the
// agent can't author). `ratifiedBy` may be a single command or a list (compiled-rules.json is armable from
// BOTH /groundtruth-rules and /groundtruth-setup); null ⇒ no command can ratify it (always flag on touch).
const isRatified = (ratifiedBy, commandsInvoked) =>
  ratifiedBy != null && (Array.isArray(ratifiedBy) ? ratifiedBy : [ratifiedBy]).some(c => commandsInvoked.has(c));
// Anchored on the tool-ledger DIFF: a Write/Edit to a referee file appears as a changed path, and the
// write is excused only if the matching slash-command ratified it (a human turn the agent can't author).
// The Bash/MCP write channel (config flip, snapshot forge/delete, rules disarm) is covered by the
// SessionStart hash snapshot — compareSnapshot reads the OUT-OF-BAND hash change, and the snapshot-absent
// check catches a delete — i.e. the write EFFECT, precisely. A prior substring scan of the command stream
// was REMOVED: it re-fired on STALE cumulative-transcript commands every turn (recorded ≠ written-this-turn)
// and false-matched read-only `cat/ls` paths — the substring-sensor mistake the snapshot already retires.
export function refereeTamper(diff = '', commandsInvoked = new Set(), envBlock = false) {
  const out = [], seen = new Set();
  const flag = (what) => { if (seen.has(what)) return; seen.add(what); out.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn', msg: `referee state touched this turn — ${what} — verdict integrity NOT guaranteed; review required` }); };
  for (const f of changedFiles(diff)) {                                   // Write/Edit tool → path in the diff
    const hit = REFEREE_FILES.find(r => r.re.test(f));
    if (hit && !isRatified(hit.ratifiedBy, commandsInvoked)) flag(hit.what);
  }
  return out;
}

// ── D9: out-of-band tamper via a content-hash snapshot ──
// refereeTamper above sees only the DIFF, so a Bash/MCP write to config.json or compiled-rules.json
// (gitignored, no Write-tool call) was invisible. Fix: snapshot the referee files' hashes at SessionStart
// and re-compare at Stop — a change with no ratifying command is out-of-band tamper, diff or no diff.
// The snapshot lives on disk too, so a smart agent could rewrite IT to match its tamper; the seal closes
// that — an HMAC keyed by env GROUNDTRUTH_KEY (out of the agent's reach, like env-block). Unsigned (no
// key) still catches the naive case (tamper the file, leave the snapshot); signed catches both.
// tasks.json is EXCLUDED — the hook rewrites it every turn, so its hash always changes (no false alarm).
// AG-A (seal the auditor's own code): the RUNNING hook's code files, sealed into the same hash snapshot.
// Resolved from `import.meta.url` (the running file's real location) as ABSOLUTE paths, NOT `join(cwd, rel)` —
// the repo being audited is not where the plugin lives, and a repo-relative regex would false-fire in the
// dogfooding/vendoring repo. Keyed by a synthetic `@hook/…` rel (a stable map key), read via `abs`.
// ratifiedBy:null — nothing in-session legitimately edits the auditor (a real plugin update is out-of-session).
// HONEST LIMIT: a TARGETED self-edit executes the already-neutered file this very turn, so in-session this is
// NOT prevention — it inherits compareSnapshot's regime split, so WITHOUT GROUNDTRUTH_KEY (the default, incl.
// this dev repo) a hook-code change is only a quiet INFO note, never a warn/block; it becomes a real block
// only in the keyed/CI rung, where a pristine runner hashes the deployed hook vs the release. That is where
// A's guarantee lives (see integrityScope). In-session value = naive/incidental edits + helper files.
// KEYED-REGIME CEILING (rare, documented not fixed): a contributor who legitimately edits the hook (or a
// mid-session plugin upgrade) in a session with GROUNDTRUTH_KEY set gets a held, unratifiable tamper finding
// (block under GROUNDTRUTH_BLOCK=1) that re-fires until the session restarts. Restart re-baselines it.
function hookCodeTargets() {
  const here = dirname(fileURLToPath(import.meta.url));
  return ['groundtruth.mjs', 'symbol-integrity.mjs', 'compile-rules.mjs']
    .map(f => ({ rel: `@hook/${f}`, abs: join(here, f), ratifiedBy: null }));
}
function snapshotTargets(session) {
  return [
    { rel: '.claude/groundtruth/config.json', ratifiedBy: 'groundtruth-block' },
    { rel: '.claude/groundtruth/compiled-rules.json', ratifiedBy: ['groundtruth-rules', 'groundtruth-setup'] },
    { rel: `.claude/groundtruth/${session}.baseline.json`, ratifiedBy: null },
    ...hookCodeTargets(),
  ];
}
const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
function snapHashes(cwd, session) {
  const m = {};
  // `abs` (the hook code) reads from the plugin dir; a bare `rel` reads from the audited repo (cwd).
  for (const { rel, abs } of snapshotTargets(session)) { try { m[rel] = sha16(readFileSync(abs || join(cwd, rel), 'utf8')); } catch { m[rel] = null; } }
  return m;
}
// `mark` is a transcript HIGH-WATER MARK: the COUNT of slash-command invocations recorded when this snapshot
// was written. It is signed alongside `files` so an agent can't lower it (to re-grant an excuse) without
// breaking the sig. Ratification is scoped to commands invoked SINCE the mark (freshRatifiers), so a command
// already accounted for can't excuse a LATER out-of-band change — the covert-redisarm fix — WITHOUT false-
// flagging a legitimate repeat arming (that turn re-supplies its command past the mark). A COUNT, not a name
// set: names are monotonic (fresh-once-per-session → a 2nd `/groundtruth-rules` arming would false-fire); a
// position advances every turn. An explicit `files` lets the Stop re-snapshot advance only legit targets.
// `observed` is the ACTUAL current hash of each target at write time — distinct from `files`, the blessed
// baseline. It lets the next turn tell a change that happened THIS turn (cur !== observed) from a divergence
// HELD from a prior turn (cur === observed). A ratifier excuses only a this-turn change, so a later routine
// command (even a read-only `/groundtruth-rules list`) can't launder a held disarm into a green. Signed too,
// so it can't be forged (rolling back the WHOLE snapshot to an old `observed` is the separate CI-only limit).
function writeRefSnapshot(cwd, session, mark = 0, files = null, observed = null) {
  files = files || snapHashes(cwd, session);
  observed = observed || files;                                  // SessionStart: nothing has diverged yet
  mark = Math.max(0, mark | 0);
  const key = process.env.GROUNDTRUTH_KEY || '';
  const sig = key ? createHmac('sha256', key).update(JSON.stringify({ files, observed, mark })).digest('hex') : null;
  // keyed records whether THIS snapshot was written under a key, so a later turn (or an older snapshot from
  // before the key was set) isn't read as a forged/downgraded one just because the env now has a key.
  try { writeFileSync(join(cwd, '.claude', 'groundtruth', `${session}.refsnapshot.json`), JSON.stringify({ files, observed, mark, sig, keyed: !!key })); } catch {}
}
function loadVerifiedSnapshot(cwd, session) {
  let snap; try { snap = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', `${session}.refsnapshot.json`), 'utf8')); } catch { return null; }
  const key = process.env.GROUNDTRUTH_KEY || '';
  const mark = Number.isInteger(snap.mark) ? snap.mark : 0;
  const observed = snap.observed || snap.files || {};            // older snapshot (no observed) ⇒ fall back to files
  const sigValid = snap.sig ? (!!key && createHmac('sha256', key).update(JSON.stringify({ files: snap.files || {}, observed, mark })).digest('hex') === snap.sig) : null;
  return { files: snap.files || {}, observed, mark, sig: snap.sig || null, sigValid, keyed: snap.keyed, targets: snapshotTargets(session) };
}
// Turn-scoped ratifiers: the command names invoked AFTER the snapshot's mark (i.e. this interval), not the
// lifetime name set. `mark` past the end (stale/forged-high) → empty → nothing excused (safe direction). Pure.
export function freshRatifiers(commandInvocations = [], mark = 0) {
  return new Set((commandInvocations || []).slice(Math.max(0, mark | 0)));
}
// Compute the NEXT snapshot. `files` = the blessed baseline: advance a target to its current hash iff the
// change is legitimate — unchanged, OR ratified-this-interval AND actually changed THIS turn (cur !== the prior
// `observed`). A divergence HELD from a prior turn (cur === priorObserved) is never blessed by a later routine
// ratifier, so an unratified tamper keeps firing until reverted. `observed` always tracks the actual current
// hash — the this-turn-change reference for next turn. Returns both maps. Pure.
export function advanceSnapshot(priorFiles = {}, priorObserved = {}, curFiles = {}, targets = [], freshCommands = new Set()) {
  const files = {}, observed = {};
  for (const { rel, ratifiedBy } of targets) {
    const pf = priorFiles[rel] ?? null, po = priorObserved[rel] ?? null, cur = curFiles[rel] ?? null;
    const legit = cur === pf || (isRatified(ratifiedBy, freshCommands) && cur !== po);   // unchanged, or ratified THIS-turn change
    files[rel] = legit ? cur : pf;
    observed[rel] = cur;
  }
  return { files, observed };
}
// PURE: compare a (verified) snapshot against current hashes. Any target changed/appeared/vanished with
// no ratifying command = out-of-band tamper. Testable without fs.
// H7: when a key IS configured, the snapshot MUST carry a VALID signature — an unsigned or mis-signed
// snapshot under a key regime is a forgery/downgrade (the agent rewrote the snapshot to match its tamper
// but can't sign it). The old check only challenged a WRONG signature, never an ABSENT one, so the agent
// just downgraded to unsigned. (No key configured ⇒ the snapshot is unsealed and forgeable — that is a
// DOCUMENTED limit, not a deterministic catch: set GROUNDTRUTH_KEY, held out of the agent's tool env.)
export function compareSnapshot(snap, curFiles = {}, freshCommands = new Set(), envBlock = false, keyConfigured = false) {
  const out = [];
  if (!snap || !snap.files) return out;                                  // no snapshot (SessionStart didn't run)
  // Was this snapshot written under a key? New snapshots record `keyed`; for an OLD one (no field) infer it
  // from the presence of a sig — so a pre-fix SIGNED snapshot still demands a valid sig, and a pre-fix
  // KEYLESS one stays legitimately unsigned. Gating on `wasKeyed` (the write-time fact), not the live
  // keyConfigured, is the version-skew fix: a keyless snapshot under a now-set key no longer reads as forged.
  const wasKeyed = snap.keyed != null ? !!snap.keyed : !!snap.sig;
  if (snap.sig && snap.sigValid === false)
    out.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn', msg: 'referee snapshot signature INVALID — the integrity snapshot itself was altered (or the key changed); verdict cannot be trusted' });
  else if (wasKeyed && !snap.sig)
    out.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn', msg: 'referee snapshot is UNSIGNED though it was written under a key — downgraded to evade the seal; verdict integrity NOT guaranteed' });
  else if (keyConfigured && !wasKeyed)
    // Env has a key now, but this session's baseline was snapshotted BEFORE any key existed (a keyless
    // SessionStart, the key added later — /groundtruth-setup, a manual `export`, or a CI env). There was never
    // a signed seal here, so nothing could have been downgraded or forged: this is "signing not active yet",
    // NOT tamper. Quiet info (the T1 regime-split) — pulled to the ⚪ footer, not injected into the next turn,
    // doesn't flip the verdict, and never renders under the alarmist "agent rewrote its OWN state" header. A
    // REAL keyed→unsigned downgrade is the branch above (stays loud); an actual out-of-band change is still
    // surfaced by the per-target loop below (info in this unsigned regime). Documented ceiling: this also
    // quiets the delete-signed-then-write-keyless dodge to info — a shell-readable key already lets a competent
    // agent write a VALID signed forgery (fully quiet today), so this warn only ever tripped a naive attacker;
    // real enforcement is a key held OUT of the agent's shell + a CI gate, exactly as integrityScope states.
    out.push({ cls: 'integrity_note', sev: 'info', msg: 'integrity signing is not active this session — the baseline was snapshotted before GROUNDTRUTH_KEY was set; restart the session to sign it. Nothing was tampered.' });
  // An out-of-band change is only AUTHORITATIVE in a trustworthy regime — a valid signature under a
  // configured key. Without that, the whole hash-snapshot is best-effort (a laundered tamper can re-forge
  // it), so firing a warn/block claims more confidence than the mechanism has, and it fired on every
  // MCP/Bash session as noise (the empirical finding: keyed:false everywhere). Split the signal:
  //   • trustworthy regime (key + valid sig), unratified change → a REAL finding (warn/block).
  //   • else → a quiet coverage-gap NOTE (cls 'integrity_note', sev 'info'): shown in the card footer for
  //     awareness, but NOT injected into the next turn and NOT flipping the verdict. Real enforcement is the
  //     signature + a CI/pre-merge gate, exactly as integrityScope already states.
  const trustworthy = keyConfigured && snap.sig && snap.sigValid === true;
  // `freshCommands` is the ratifiers invoked SINCE this snapshot's mark (the caller computes it via
  // freshRatifiers(commandInvocations, snap.mark)) — a command already accounted for at snapshot time cannot
  // excuse a LATER out-of-band change. This closes the covert-redisarm window while still excusing a legitimate
  // repeat arming (that turn re-supplies its command past the mark). Empty ⇒ nothing excused this interval.
  for (const { rel, ratifiedBy } of (snap.targets || [])) {
    if ((snap.files[rel] ?? null) === (curFiles[rel] ?? null)) continue;  // unchanged vs the blessed baseline
    // Excuse only a change that (a) is ratified this interval AND (b) actually happened THIS turn — cur differs
    // from the prior `observed`. A divergence HELD from a prior turn (cur === observed) is NOT excused by a
    // later routine ratifier (e.g. a read-only `/groundtruth-rules list`), so a held disarm keeps firing.
    if (isRatified(ratifiedBy, freshCommands) && (curFiles[rel] ?? null) !== (snap.observed?.[rel] ?? null)) continue;
    if (trustworthy)
      out.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn',
        msg: `referee state changed OUT-OF-BAND since session start — ${rel.split('/').pop()} (a Bash/MCP write the diff can't see); verdict integrity NOT guaranteed` });
    else
      out.push({ cls: 'integrity_note', sev: 'info',
        msg: `${rel.split('/').pop()} differs from session start via a non-diff channel — best-effort/unsigned, shown for awareness only. Set GROUNDTRUTH_KEY (out of the agent's shell) + gate in CI for real enforcement.` });
  }
  return out;
}

/**
 * Procedural compliance — did the agent's ORDERED tool calls follow a declared step-procedure?
 * Grounded in the transcript's command sequence, no LLM. Three primitives, the universal vocabulary:
 *   forbid_present {match}          — a command matching `match` must NOT appear (e.g. a real prod write)
 *   require_present {when?, match}  — if `when` appears (or always), a `match` command must appear
 *   require_order   {before, after} — every `after` command must be preceded by a `before` (e.g. :dry first)
 * Rules are per-project (.claude/groundtruth/procedures.json); the engine is universal.
 */
export function runProcedures(cmds = [], procedures = []) {
  const findings = [];
  const rx = (p) => { try { return new RegExp(p, 'i'); } catch { return null; } };
  for (const r of procedures) {
    const sev = r.sev || 'warn';
    if (r.kind === 'forbid_present') {
      const m = rx(r.match);
      if (m && cmds.some(c => m.test(c))) findings.push({ cls: 'P', sev, msg: r.message });
    } else if (r.kind === 'require_present') {
      const when = r.when ? rx(r.when) : null, m = rx(r.match);
      const triggered = !when || cmds.some(c => when.test(c));
      if (triggered && m && !cmds.some(c => m.test(c))) findings.push({ cls: 'P', sev, msg: r.message });
    } else if (r.kind === 'require_order') {
      const before = rx(r.before), after = rx(r.after);
      if (before && after && cmds.some((c, i) => after.test(c) && !cmds.slice(0, i).some(p => before.test(p))))
        findings.push({ cls: 'P', sev, msg: r.message });
    }
  }
  return findings;
}

export function loadProcedures(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', 'procedures.json'), 'utf8')); }
  catch { return []; }
}

// Plugin-managed config (.claude/groundtruth/config.json) so the user never edits settings.json: block
// mode is opt-in here, default warn. The `/groundtruth-block on|off` command writes this. The env var
// GROUNDTRUTH_BLOCK still works (back-compat) and wins if set.
export function loadGtConfig(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', 'config.json'), 'utf8')) || {}; }
  catch { return {}; }
}

/**
 * §7 pre-flight: how verifiable is the CONTRACT itself? A prompt that names no file/component, no
 * concrete deliverable, and no test/acceptance cue can't have its COMPLETENESS checked (nothing to
 * map subtasks against) — so a green from it is lower-confidence. Honesty (claim) + rules don't
 * degrade. Used by the UserPromptSubmit pre-flight AND to mark the Stop verdict. Pure + tested.
 */
export function intentConfidence(intent = '') {
  const t = (intent || '').trim();
  // Empty / command-only turn → NO gradeable ask at all (distinct from a vague-but-real ask). Abstain
  // on completeness rather than pass it — verification is only as strong as the captured intent (§7).
  if (!t) return { tier: 'none', reasons: ['no gradeable ask (empty or command-only turn)'] };
  const namesTarget = new RegExp('[\\w/-]+\\.(?:' + SRC_EXT + ')\\b', 'i').test(t)
    || /`[^`]+`/.test(t)                          // backticked path / symbol
    || /\b[a-z]+[A-Z][a-zA-Z]+\b/.test(t);        // a camelCase symbol
  const hasCriteria = /\b(tests?|should|verify|ensure|make sure|so that|expect|acceptance|criteri|must)\b/i.test(t);
  const hasDeliverable = /\b(button|endpoint|route|function|method|class|table|column|field|page|component|module|hook|modal|form|api|migration|policy|check|rule|script|command|flag|index|query|schema|gate)\b/i.test(t);
  if (namesTarget || hasCriteria || hasDeliverable) return { tier: 'tight', reasons: [] };
  return { tier: 'thin', reasons: ['no named file/component', 'no concrete deliverable', 'no test/acceptance cue'] };
}

// ── One-time "star the repo" ask ────────────────────────────────────────────────────────────────────
// Rides the SAME channel that fixed the silent-warn gap: the UserPromptSubmit `additionalContext`
// injection (§--intent). The verdict card is invisible in the VS Code chat — .md/stderr/systemMessage
// none reliably render — so this is the one surface that reaches the user. Gated three ways so it only
// ever lands at a good moment:
//   • EARNED — only after ≥ STAR_AFTER verdicts in THIS repo (the tool has already proven itself)
//   • CALM   — only when the LAST verdict wasn't a 🔴 block AND this turn has no pending findings (the `ctx ||`
//              short-circuit at the call site), so the ask stands alone and never lands mid-fix — even across
//              a session boundary, where this turn's findings.json doesn't exist yet
//   • ONCE   — a global flag in ~/.claude → once per machine, not once per repo, so no cross-repo re-nag
const STAR_AFTER = 5;
const STAR_URL = 'https://github.com/akahkhanna/groundtruth';

/** Pure gate — the whole policy, testable without fs. */
export function shouldAskStar({ hasBlock, priorVerdicts, alreadyShown }) {
  return !hasBlock && !alreadyShown && priorVerdicts >= STAR_AFTER;
}

/** fs wrapper: counts prior verdicts + reads the last verdict + reads/sets the global once-flag;
 *  returns the additionalContext note or ''. Called only on a turn with no pending findings. */
function starNudge(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return '';                                     // no home → can't dedupe once-ever → stay quiet
  const flag = join(home, '.claude', '.groundtruth-starred');
  let priorVerdicts = 0, lastVerdict = '';
  try {
    const lines = readFileSync(join(cwd, '.claude', 'groundtruth', 'history.jsonl'), 'utf8').split('\n').filter(Boolean);
    priorVerdicts = lines.length;                           // one \n-terminated record per turn → exact count
    try { lastVerdict = JSON.parse(lines[lines.length - 1]).verdict || ''; } catch {}   // don't beg right after a block
  } catch {}
  if (!shouldAskStar({ hasBlock: lastVerdict === 'block', priorVerdicts, alreadyShown: existsSync(flag) })) return '';
  try { writeFileSync(flag, new Date().toISOString() + '\n'); }
  catch { return ''; }                                      // can't record "shown" → don't show (else it nags next turn)
  // Relayed once (not "do not reply" like the findings note) — a clickable link only reaches the VS Code
  // chat if the agent surfaces it, and this fires exactly once ever.
  return `[Groundtruth — one-time note, never repeated. Relay this single line to the user verbatim, then carry on with their request:\n⭐ Groundtruth has checked ${priorVerdicts}+ of your turns here — if it's saved you a bad "done", a star helps others find it → ${STAR_URL}]`;
}

/** Render the verdict card — self-explanatory: the ASK, what was checked per dimension (with the
 *  findings nested under it), and what the verdict MEANS (esp. why confidence is low). One place →
 *  terminal, .md, chat echo. */
export function renderCard(findings, { session = 'unknown', intent = '', blockEnabled = false, baseline = null, pendingRules = 0, integrity = '' } = {}) {
  // Quiet awareness NOTES (info-tier, e.g. an unsigned-regime coverage-gap) are pulled OUT before any finding
  // logic: they never flip the verdict, never enter the Honesty/Integrity sections, and (via sev!==warn/block)
  // are never injected into the next turn — they render only as a ⚪ footer.
  const notes = (findings || []).filter(f => f.cls === 'integrity_note' || f.sev === 'info');
  findings = (findings || []).filter(f => !(f.cls === 'integrity_note' || f.sev === 'info'));
  const SEV = { block: '🔴', warn: '🟡' };          // RAG: red = block, amber = warn, green = clean
  const _raw = (intent || '').replace(/\s+/g, ' ').trim();
  const ask = _raw ? (_raw.length > 130 ? _raw.slice(0, 130).replace(/\s\S*$/, '') + '…' : _raw) : '(no prompt captured)';
  const ic = intentConfidence(intent);
  const hasBlock = findings.some(f => f.sev === 'block');
  const hasAsync = findings.some(f => f.cls === 'async_done');     // false-completion: claimed done, work unfinished
  const dot = hasBlock ? '🔴' : hasAsync ? '⏳' : (findings.length || ic.tier === 'thin') ? '🟡' : '🟢';

  const isHonesty = f => [1, 2, 3, 4, 6, 9, 'async_done', 'test_exclusion', 'test_weakened', 'NC', 'CA', 'UC'].includes(f.cls);   // false-claim / stub / no-op / phantom / dangling-ref / special-casing / false-completion / test-exclusion / test-weakened / (v2 contract) no-contract / claimed-but-absent / undeclared-change
  const sortF = a => [...a].sort((x, y) => (x.sev === 'block' ? 0 : 1) - (y.sev === 'block' ? 0 : 1));
  const sub = f => `       ${SEV[f.sev]} ${CLASS_NAME[f.cls] || f.cls}${f.rule ? ` [${f.rule}]` : ''} — ${f.msg}`;
  const hon = findings.filter(isHonesty);
  const deferred = findings.filter(f => f.cls === 'deferred');              // declared deferral: surfaced, never silent
  const tamper = findings.filter(f => f.cls === 'tamper');                  // agent rewrote the referee's own state
  const rule = findings.filter(f => !isHonesty(f) && !['deferred', 'tamper'].includes(f.cls));  // security B/C + compiled rules R

  const verdict = (hasBlock ? 'ISSUES — blocked'
    : hasAsync ? 'IN PROGRESS — not done (deliverable not produced yet)'
    : !findings.length ? 'Told & Done'
    : `WARN — ${findings.length} finding${findings.length > 1 ? 's' : ''}`)
    + (ic.tier === 'thin' && !hasAsync ? ' · LOW-CONFIDENCE' : '');
  const means = hasBlock ? 'a blocking issue is in the diff above — fix it before this ships'
    : hasAsync ? 'the agent claimed done but the work is still unfinished — wait for the deliverable, then re-check; do NOT relay "done"'
    : findings.length ? 'non-blocking issues above to review'
    : ic.tier === 'thin' ? "nothing was caught, but completeness can't be proven from this vague ask — name a file/test for a full 🟢"
    : 'deterministic checks are clean';

  return [
    `GROUNDTRUTH · Tier-1 · ${session.slice(0, 8)}`,
    `  ASK  ${ask}`,
    '',
    `  WHAT WAS CHECKED:`,
    ...(tamper.length ? [
      `  ${tamper.some(f => f.sev === 'block') ? '🔴' : '🟡'} Integrity — the agent rewrote Groundtruth's OWN state this turn (verdict below may be compromised):`,
      ...tamper.map(f => `       ${tamper.some(x => x.sev === 'block') ? '🔴' : '⚠'} ${f.msg}`),
    ] : []),
    hon.length ? `  🔴 Honesty — the agent's claims don't match what it did:` : `  🟢 Honesty — claims match the diff + run evidence (no false "done", stub, no-op, or phantom import)`,
    ...sortF(hon).map(sub),
    rule.length ? `  🔴 Rules — a security / standing rule was broken in the diff:` : `  🟢 Rules — no security or directive rule broken (RLS, secrets, your compiled rules)`,
    ...sortF(rule).map(sub),
    ...(rule.some(f => f.rule) ? [`       ⚪ a rule firing wrongly? silence it → /groundtruth-rules unarm <id> (the [id] on each line above)`] : []),
    ic.tier === 'none'
      ? `  ⚪ Completeness — n/a: this turn carries no gradeable ask (a command invocation or empty prompt), so there is nothing to check off`
      : ic.tier === 'thin'
      ? `  🟡 Completeness — NOT verified: the ask named no file / deliverable / test, so there were no subtasks to check off`
      : `  🟢 Completeness — the ask was specific enough to map subtasks against`,
    // Tasks (v2): the prose open-loop ledger is retired — completeness is now the contract's CA (a declared
    // deliverable that never landed) and UC (a change never declared), both under Honesty above. This line
    // surfaces only the agent's OWN declared deferrals; when there are none it stays neutral, never asserting
    // an ungrounded "everything delivered" (the check that used to back that claim no longer exists).
    deferred.length
      ? `  🟡 Tasks — ${deferred.length} declared deferral(s) (the agent's own set-aside, surfaced for transparency):`
      : `  🟢 Tasks — nothing deferred`,
    ...deferred.map(f => `       ⊘ ${f.msg}`),
    baseline
      ? `  ⚪ Debt — ${baseline.preExisting} pre-existing (already here at session start, not blamed) · ${baseline.introduced} introduced this turn`
      : `  ⚪ Debt — no baseline captured (diffed against HEAD)`,
    '',
    `  VERDICT  ${dot} ${verdict}${hasBlock && !blockEnabled ? '   (GROUNDTRUTH_BLOCK=1 to halt)' : ''}`,
    `       means: ${means}`,
    ...(integrity ? integrity.split('\n').map(l => `  ${l}`) : []),
    ...(pendingRules ? [`  ⚪ ${pendingRules} rule(s) proposed from your docs await approval → /groundtruth-rules to review + arm`] : []),
    ...notes.map(f => `  ⚪ ${f.cls === 'integrity_note' ? 'Integrity note' : 'Aside'} (awareness only, not a finding) — ${f.msg}`),
    `  ⚪ Deterministic verdict (no LLM). Semantic checks — spec-substitution, "rationalised past a rule", regression — are roadmap, not in this card.`,
  ].join('\n');
}

// The verdict must declare its OWN integrity scope so a green doesn't overclaim. In-session, referee
// integrity is EVIDENCE, not enforcement: a DIRECT tamper surfaces, but a LAUNDERED one (a helper that
// flips state AND re-forges the snapshot in one command) is recorded yet unrecognised and can pass green
// — UNLESS GROUNDTRUTH_KEY is set AND held outside the agent's shell (then the re-forge can't be signed).
// The deterministic boundary is a CI/pre-merge gate the agent's shell can't reach. Pure → testable.
export function integrityScope(keyConfigured = false) {
  return keyConfigured
    ? '⚠ Integrity: signed-snapshot regime — a laundered referee-state tamper is caught ONLY if GROUNDTRUTH_KEY is held OUT of the agent\'s shell env. In-session is evidence; the enforcement boundary is a CI/pre-merge gate.'
    : '⚠ Integrity: BEST-EFFORT — no GROUNDTRUTH_KEY, so a LAUNDERED referee-state write (a helper that re-forges the snapshot) can pass THIS green. Direct tamper still surfaces. For real enforcement: set GROUNDTRUTH_KEY out of the agent\'s shell + gate in CI/pre-merge.';
}

// A fix attempt that edits TEST/SPEC files is gaming the check (turning it green without fixing code).
// Referee-state files (.claude/groundtruth/*) are deliberately NOT matched here: refereeTamper already
// guards the ledger, and including them mis-attributed a LEGIT earlier `/groundtruth-rules` arming (still
// present in the CUMULATIVE diff) as "GAMING DETECTED" on a later, unrelated text-only turn. Tests/specs
// only — the same cross-language TEST_FILE_RE the Class-1 anti-gaming warn uses.
export const GAMED_FILE_RE = TEST_FILE_RE;

// ── Remediation loop (§13/§14) — block a FIXABLE catch, hand back a corrective payload, let the
//    agent self-correct, capped at 2 attempts, then escalate (never wedge). async_done + warns never
//    enter this (they're sev:warn). The decision is pure + tested; main() owns the attempts file. ──
export function remediationDecision({ attempts = 0, gamed = false, cap = 2 } = {}) {
  // Gaming must NOT be an escape hatch (the old behaviour escalated → RELEASED the block, so editing a
  // test "resolved" the catch). But it must also not WEDGE: a frozen counter means a LEGITIMATE fix that
  // edits a *.test.* file blocks FOREVER. So gaming still INCREMENTS toward the cap (block held, flagged),
  // then terminates at human escalation like any unresolved catch — never auto-release, never infinite.
  if (attempts >= cap) return { action: 'escalate', gamed, why: gamed ? `gaming flagged + unresolved after ${attempts} attempts` : `unresolved after ${attempts} attempt${attempts === 1 ? '' : 's'}`, nextAttempts: 0 };
  return { action: 'block', gamed, why: gamed ? 'a fix attempt edited the tests / this checker / the ledger — gaming does not release the block' : '', nextAttempts: attempts + 1 };
}

// Never-lost floor (Defect B): when block mode actually HALTS or RELEASES a turn, the outcome must reach
// the user. In the VS Code extension `systemMessage` doesn't render and the corrective `reason` goes only
// to the model, so a block/escalate can loop or release invisibly. This synthesises an outcome marker that
// is persisted into <session>.findings.json; the NEXT turn's UserPromptSubmit banner (priorFindingsContext)
// renders it loudly and instructs the agent to surface it. Returns null when there is nothing to report.
// `effective` is the outcome ACTUALLY taken (a block whose attempts-file write failed degrades to escalate).
// Pure → tested.
export function blockOutcomeNote(effective, attempt = 1, cap = 2, gamed = false) {
  if (effective === 'block')
    return { cls: 'blocked', sev: 'block', msg: `your PREVIOUS turn was BLOCKED by Groundtruth (attempt ${attempt}/${cap})${gamed ? ' — a fix attempt edited the tests/checker/ledger, flagged as gaming' : ''}; the turn did not end. This CAN be a false positive — verify it against reality, then fix the code or tell the user. Do not silently retry.` };
  if (effective === 'escalate')
    return { cls: 'escalated', sev: 'block', msg: `your PREVIOUS turn ESCALATED — Groundtruth released the block after ${attempt} attempt${attempt === 1 ? '' : 's'}; the work PROCEEDED UNVERIFIED and needs human review. Tell the user what was flagged.` };
  return null;
}

// Defect B step 2 — the LIVE (this-instant) surface. Pure: choose a command to pop a block/escalate
// notice, given the outcome, the environment, the platform, and the verdict-file path. Returns {cmd,args}
// or null. TWO hard rules: (1) the message is FIXED — never interpolate finding text (it carries
// repo-controlled filenames/task strings, an injection vector into the referee's process); the detail lives
// in the verdict file / the never-lost banner. (2) VS Code (incl. Remote/devcontainer, where a desktop
// toast has no display to reach) → open the verdict file via the `code` CLI in the connected window; only a
// local desktop falls back to a native toast. Caller spawns this DETACHED + fail-open so a missing binary or
// a hung dialog can never stall or crash the Stop hook. Best-effort by construction — the guaranteed floor is
// the never-lost banner; this is the in-the-moment nicety. Pure → tested.
// Resolve an editor CLI actually on PATH (VS Code / Cursor / Insiders / VSCodium / Windsurf). This is the
// RELIABLE VS-Code signal — env vars (TERM_PROGRAM/VSCODE_*) are set in the integrated terminal but not always
// in the hook's process env (the earlier `code -r` never fired because env detection failed; the user got a
// dead toast instead). Presence of the `code` CLI is a durable, inheritable signal. Cheap `which`/`where`,
// run once per catch. Returns the bin name (spawn resolves via PATH) or null.
export function editorCli(which = (bin) => { try { return !!execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); } catch { return false; } }) {
  for (const bin of ['code', 'cursor', 'code-insiders', 'codium', 'windsurf']) if (which(bin)) return bin;
  return null;
}
// The LIVE (this-instant) surface(s). Pure: given the outcome, verdict path, platform, and a resolved editor
// bin, return the list of commands to fire. Returns an ARRAY so we do BOTH when we can: OPEN THE VERDICT in the
// editor (the actionable thing the user's "Open" should do — a bare macOS toast only re-opens Finder) AND a
// desktop toast as the attention-grab. Message is FIXED — never interpolate finding text (repo-controlled
// filenames/task strings are an injection vector). Caller spawns each DETACHED + fail-open. Best-effort; the
// guaranteed floor is the never-lost banner. Pure → tested.
export function liveNoticeCmds(effective, mdPath = '', platform = process.platform, editorBin = null, env = {}) {
  const title = 'Groundtruth';
  const body = effective === 'escalate'
    ? 'ESCALATED — block released, the work is UNVERIFIED. Review needed.'
    : 'BLOCKED this turn — the verdict was opened; it may be a false positive.';
  const cmds = [];
  if (editorBin && mdPath) cmds.push({ cmd: editorBin, args: ['-g', mdPath] });   // best: editor CLI on PATH, -g opens+focuses (Remote-safe)
  // macOS fallback when the `code` shell command isn't installed (the common case that gave the user a dead
  // toast): open the verdict in the app that LAUNCHED the hook, by its bundle id (__CFBundleIdentifier is
  // inherited from the GUI app). No CLI needed. Gated to editor-ish bundle ids so we never open a random app.
  else if (platform === 'darwin' && mdPath && /vscode|vscodium|windsurf|\.code\b|sublime|jetbrains|cursor|todesktop/i.test(env.__CFBundleIdentifier || ''))
    cmds.push({ cmd: 'open', args: ['-b', env.__CFBundleIdentifier, mdPath] });
  if (platform === 'darwin') cmds.push({ cmd: 'osascript', args: ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`] });
  else if (platform === 'linux') cmds.push({ cmd: 'notify-send', args: [title, body] });
  return cmds;   // empty (e.g. bare Windows, no editor CLI) → the never-lost banner still carries it next turn
}

// Per-class corrective payload (§15): name the TARGET STATE, not just "fix it".
const FIX = {
  1: 'Run the test/build you claimed passed (do NOT edit the test to make it pass), or correct the claim.',
  2: 'Implement the stub body — remove the TODO / placeholder / not-implemented.',
  3: 'Actually make the change you claimed (the named file/symbol is absent from the diff), or correct the claim.',
  4: 'Fix the import — the referenced module/symbol does not resolve in the tree.',
  6: 'Restore or relocate the removed function/method (its name is defined nowhere in the tree), or update the quoted dangling caller(s). If the removal was intended, fix the callers — a preservation claim over a broken call is the finding.',
  B1: 'Add `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for the new table, in the SAME migration.',
  B3: 'Remove (or scope with auth.uid()) the `TO public/anon … USING(true)` policy — it exposes every row.',
  C1: 'Remove the hardcoded secret; move it to an env var / secret store and rotate it.',
  C2: 'Remove the committed private key; rotate it.',
  ENV: 'Add the env file to .gitignore (and `git rm --cached` it if already tracked); rotate any secret it held.',
};
export function renderCorrective(blockFindings, attempts, cap = 2) {
  return `Groundtruth blocked this stop (attempt ${attempts}/${cap} before it escalates to a human). Resolve, then finish:\n`
    + blockFindings.map(f => `  • [${CLASS_NAME[f.cls] || f.cls}] ${FIX[f.cls] || f.msg}`).join('\n')
    + `\nDo NOT edit the tests, this checker, or the groundtruth ledger to satisfy it — that KEEPS the block and flags a human.`;
}

// Pull untracked working-tree files' on-disk content into the scanned reality (the D7 reality blind
// spot). `git diff` ignores untracked files, and the Write/Edit tool-ledger never sees a Bash-written
// file — so a secret in `printf > leak.js` was a 0-line diff. Disk is ground truth; read it. Skips the
// hook's own state dir (tamper-handled), binaries, and files already in the diff (`skip`). ~free.
// Scan each untracked file up to a PER-FILE ceiling — a secret on the LAST line must be caught, not just the
// first 1 MB (the old cap left a "hide the key past 1 MB" hole). 64 MB covers every realistic secret-bearing
// file (a .env / config / source is kilobytes). A TOTAL budget across ALL untracked files then bounds the
// CONSUMER: `content` is regex-scanned as one string and Node caps a single string at ~512 MB, so WITHOUT a
// total cap a few large un-gitignored data files would move the OOM/stall from the read to the per-turn scan
// (or throw RangeError and, via the swallowing catch, silently skip later files — a padding bypass). Once the
// budget is spent, remaining files are SURFACED (oversized), never silently dropped, so padding still can't buy
// a green. Common case (little/no untracked text) stays ~free; only a big-untracked-blob repo pays the bounded
// cost. Both caps are parameters so the self-check can drive tiny ones deterministically.
const UNTRACKED_SCAN_CAP = 64 * 1024 * 1024;      // per file
const UNTRACKED_TOTAL_CAP = 128 * 1024 * 1024;    // across all untracked files. Budget is checked BEFORE a read, so one file overshoots; the printable transform (`+`-prefix per line) can ~2× a file, so worst-case content ≈ total + 2×per-file = 128 + 2×64 = 256 MB — still safely < Node's ~512 MB string cap.
export function untrackedAdded(cwd, skip = new Set(), perFileCap = UNTRACKED_SCAN_CAP, totalCap = UNTRACKED_TOTAL_CAP) {
  let content = ''; const oversized = []; const paths = []; let gitOk = false;
  try {
    // maxBuffer: execSync defaults to 1 MiB stdout; a repo with >1 MiB of untracked FILENAMES would throw into
    // the outer catch and silently skip the WHOLE untracked scan (a coverage hole). 256 MiB covers any real tree.
    const porcelain = execSync('git status --porcelain=v1 --untracked-files=all', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    gitOk = true;   // `git status` succeeded → `paths` is an AUTHORITATIVE (possibly empty) untracked list
    for (const ln of porcelain.split('\n').filter(Boolean)) {
      if (!ln.startsWith('??')) continue;                               // untracked only — tracked edits are in git diff
      const f = ln.slice(3).trim().replace(/^"(.*)"$/, '$1');
      // Skip throwaway paths (tmp/scratch/absolute/../ + GT's own state) at the SOURCE, not just via the
      // downstream dropExcludedFiles content filter: a tmp/ blob is not a deliverable, so it must be neither
      // secret-SCANNED nor surfaced as `oversized`. Before this, an oversized tmp/ file (dropped from `content`)
      // still leaked its `oversized` entry into findings and fired the "too large to scan" warn every turn.
      if (skip.has(f) || excludedScanPath(f)) continue;
      // Record the untracked PATH regardless of read outcome (binary / oversized / unreadable still EXIST on
      // disk) — the contract's `created`-claim check gates its synthetic `A` on disk presence via this set, so
      // it must be complete, not limited to files whose content we scanned. (Fable adversarial FP-5/FN-5/FP-8.)
      paths.push(f);
      // Total budget spent → surface the rest WITHOUT reading (bounds consumer memory/time; never silent).
      if (content.length >= totalCap) { let sz = 0; try { sz = statSync(join(cwd, f)).size; } catch {} oversized.push(`${f}${sz ? ` (${sz} bytes)` : ''} — scan budget exhausted, review manually`); continue; }
      // Bounded partial read (open+read up to the cap) instead of readFileSync-the-whole-file: caps memory to
      // the scan window even for a multi-GB blob, so the read itself can't OOM the hook.
      // An UNREADABLE file (permission denied, e.g. a `chmod 000` blob) must be SURFACED, not silently skipped —
      // else a secret can hide behind a stripped read bit. statSync only needs dir search, so size still shows.
      let fd; try { fd = openSync(join(cwd, f), 'r'); } catch { let sz = 0; try { sz = statSync(join(cwd, f)).size; } catch {} oversized.push(`${f}${sz ? ` (${sz} bytes)` : ''} — unreadable (permission denied), review manually`); continue; }
      let size = 0, off = 0, buf;
      try {
        size = fstatSync(fd).size;
        const want = Math.min(size, perFileCap);
        buf = Buffer.allocUnsafe(want);
        while (off < want) { const n = readSync(fd, buf, off, want - off, off); if (n <= 0) break; off += n; }
      } catch { try { closeSync(fd); } catch {} continue; }
      try { closeSync(fd); } catch {}
      // H5/H6: do NOT skip a file by extension OR by a binariness heuristic — both were one-token
      // bypasses (rename to .lock; prepend one NUL). Secrets are PRINTABLE, so EXTRACT the printable runs
      // (non-printable bytes → line breaks) and scan those. A real binary just yields short runs the
      // specific secret patterns won't match; a text file with an injected NUL is fully scanned.
      const printable = buf.subarray(0, off).toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, '\n');
      if (printable.trim()) content += `\n+++ b/${f}\n` + printable.split('\n').map((l) => '+' + l).join('\n');
      if (size > off) oversized.push(`${f} (${size} bytes) — only the first ${Math.floor(perFileCap / (1024 * 1024))} MB scanned, review the remainder`);   // truncated at the per-file cap → surfaced, never silently trusted
    }
  } catch { /* no git → skip */ }
  // paths === null signals "untracked list UNKNOWN" (no-git / `git status` failed, e.g. a held index.lock) so
  // the contract's synthetic-`A` mint falls back to the ledger instead of treating an EMPTY array as "nothing
  // is untracked" — which would block every honest Write-created `created` claim on the fail-open path. An
  // empty (but git-confirmed) list stays []. (Fable review D1.)
  return { content, oversized, paths: gitOk ? paths : null };
}

// ── main: only when run directly, not when imported by the test ──
// Surface the PRIOR turn's findings into the NEXT turn's context (via the UserPromptSubmit --intent hook),
// so the agent — not just a .md nobody opens in VS Code — actually sees them and can triage. Passive FYI:
// injecting the full card here once made the model reply UNPROMPTED (see the Stop path), so it says
// explicitly "don't reply, triage only". Empty in → '' (a clean turn injects nothing). Pure + tested.
export function priorFindingsContext(findings = []) {
  const f = (findings || []).filter(x => x && (x.sev === 'warn' || x.sev === 'block'));
  if (!f.length) return '';
  // Never-lost floor: a block/escalate outcome marker (blockOutcomeNote) turns this from an awareness-only
  // FYI into an ACTION-NEEDED banner — the block halted or released the PREVIOUS turn invisibly (systemMessage
  // doesn't render in the VS Code extension), so this is the first surface that reaches the user, on their
  // next prompt. Unlike the warn note, this one DOES tell the agent to surface it (a block is exactly when an
  // unprompted user-facing reply is wanted). Rendered even if the outcome is the only finding.
  const outcome = f.find(x => x.cls === 'blocked' || x.cls === 'escalated');
  const rest = f.filter(x => x !== outcome);
  const lines = rest.map(x => `  • [${x.sev}] ${CLASS_NAME[x.cls] || x.cls} — ${x.msg}`).join('\n');
  if (outcome) {
    const verb = outcome.cls === 'escalated' ? 'ESCALATED' : 'BLOCKED';
    return `[Groundtruth — ACTION NEEDED (not awareness-only). 🔴 ${verb}: ${outcome.msg}]`
      + (rest.length ? `\nWhat was flagged:\n${lines}` : '')
      + `\nTell the user this happened and why; if it looks like a false positive, say so plainly. Do not bury it.`;
  }
  return `[Groundtruth — audit of your PREVIOUS turn's diff, for awareness only; warn-level, some may be false positives (e.g. a pattern self-match). Do NOT reply to this note; act on a finding only if it's relevant to the current request, and verify it against reality first.]\n${lines}`;
}

// (Re)compile the deterministic doc-rules into proposed-rules.json — shells out to compile-rules.mjs,
// which git-greps your rule docs (CLAUDE.md / SCHEMA.md / SKILL.md / …) for the `X` not `Y` / never `X`
// forms (NO LLM). Returns the proposed count. Shared by SessionStart (init-at-load) and --watch-rules
// (mid-session, when a rule doc is edited); clears the rules.dirty marker. Caller wraps in try (fail-open).
function recompileRules(cwd) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execSync(`node ${JSON.stringify(join(here, 'compile-rules.mjs'))} ${JSON.stringify(cwd)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { rmSync(join(cwd, '.claude', 'groundtruth', 'rules.dirty'), { force: true }); } catch {}
  return (out.match(/^PROPOSED (\d+)/m) || [])[1] || '?';
}

// A MANUAL (in-your-editor) edit to a rule doc doesn't fire the --watch-rules PostToolUse hook — that only
// fires on the Edit/Write TOOLS — so the PROPOSED set would go stale until the next SessionStart. Pure
// staleness test (mtimes injected): no proposed file yet, or any rule-source doc newer than it → a recompile
// is due. PROPOSED only — this never arms anything. Tested.
export function proposedStale(proposedMtime, srcMtimes = []) {
  if (proposedMtime == null) return true;                          // never compiled → due
  return srcMtimes.some(m => m != null && m > proposedMtime);
}

// The `.git/hooks/pre-commit` body `--install-pre-commit` writes. Pure + exported so its invariants are
// regression-tested. `gtPath` is a DECODED absolute path (fileURLToPath, not %20-encoded). Single-quoted
// so a space / `"` / `$` in the path can't break or inject. Fail-OPEN twice — missing `node` (GUI git
// clients run hooks with a minimal PATH: exit 127 would BLOCK every commit) and missing script (stale
// path after a plugin update) each `exit 0` with a stderr breadcrumb, never a silent-inert or a wedge.
export function preCommitHookScript(gtPath, marker = 'groundtruth-pre-commit') {
  const q = "'" + String(gtPath).replace(/'/g, `'\\''`) + "'";
  return `#!/bin/sh\n# ${marker} (auto-installed — re-run \`--install-pre-commit\` after a plugin update if the path moves)\n`
    + `GT=${q}\n`
    + `command -v node >/dev/null 2>&1 || { echo "groundtruth: node not on PATH — skipping pre-commit scan" >&2; exit 0; }\n`
    + `[ -f "$GT" ] || { echo "groundtruth: hook script missing ($GT) — skipping; re-run --install-pre-commit" >&2; exit 0; }\n`
    + `exec node "$GT" --pre-commit\n`;
}

// Parse+VALIDATE a `--diff-range` arg. The range reaches `git` via execSync, so it must be a safe ref
// token — reject anything with a shell metachar (`;`, `$(…)`, spaces, quotes). Returns { ok, range, head }
// where head = the tip to grep (the segment after `..`/`...`, else HEAD). Exported for the injection test.
export function parseDiffRange(range) {
  const r = String(range || '').trim();
  if (!/^[\w./~^@+-]+(?:\.\.\.?[\w./~^@+-]*)?$/.test(r)) return { ok: false };
  const parts = r.split(/\.\.\.?/);                       // `abc..` → ['abc','']; `..def` → ['','def']
  if (parts.some(s => s.startsWith('-'))) return { ok: false };   // a `-`-leading segment is an arg-injection (`--ext-diff`), never a legit ref — reject at the boundary, not incidentally at the resolve-guard
  const head = r.includes('..') ? (parts[parts.length - 1] || 'HEAD') : 'HEAD';
  return { ok: true, range: r, head };
}

// The per-turn findings projection persisted to `<session>.findings.json` (re-injected into the next turn) and
// appended to history.jsonl (the weekly harvest AND the /groundtruth-block fire-count review). Keeps only
// surfaceable, non-quiet findings; carries the compiled-rule `id` so per-rule fire counts are computable at
// the block gate — a bare {cls,sev,msg} could only be matched by fragile message-substring. Pure → testable.
export function projectFindings(findings) {
  return (findings || [])
    .filter(f => (f.sev === 'warn' || f.sev === 'block') && !f.quiet)
    .map(f => (f.rule ? { cls: f.cls, sev: f.sev, msg: f.msg, rule: f.rule } : { cls: f.cls, sev: f.sev, msg: f.msg }));
}

function main() {
  const git = (args, cwd) => {
    try { return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return ''; }
  };
  // Pin the diff PREFIX config on every `git diff` we parse. A user's gitconfig can set diff.mnemonicPrefix
  // (emits `c/ w/i/ …` instead of `a/ b/`), diff.noprefix (no prefix at all), or custom diff.srcPrefix/
  // dstPrefix — any of which makes `stripAB`/the header parser mis-read EVERY path, so an honest claim gets
  // a block-tier CA "absent from the diff" and its file also shows as an undeclared UC. That silently poisons
  // every verdict for a whole config population (Fable adversarial FP-3). Force the canonical a/ b/ form (and
  // pin quotePath/color so decode + parse stay deterministic regardless of the ambient config).
  const DIFF_CFG = '-c diff.mnemonicPrefix=false -c diff.noprefix=false -c diff.srcPrefix=a/ -c diff.dstPrefix=b/ -c core.quotePath=true -c color.diff=never';
  // `--no-ext-diff` (a `git diff` OPTION, so it follows the subcommand — not a top-level `-c`) neutralizes a
  // configured `diff.external` / `GIT_EXTERNAL_DIFF` (e.g. difftastic: `git config diff.external difft`), which
  // otherwise replaces the whole diff with an external tool's output — no `diff --git` headers → filesFromDiff
  // parses ZERO files → every honest claim is a block-tier CA. Same "poisons every verdict for a config
  // population" failure as the prefix knobs, via a different knob. (Fable review D2.)
  const gitDiffCfg = (rest, cwd) => git(`${DIFF_CFG} diff --no-ext-diff ${rest}`, cwd);
  // Shared searcher for the Class-6 dangling-ref check (used by BOTH the Stop path and the pre-commit
  // path). `-E` POSIX ERE (not `-P` — PCRE isn't guaranteed, and a `-P` error would throw → fail-open →
  // silently inert; the real receiver-gated classification is done in JS). It MUST distinguish `git grep`'s
  // exit-1 (clean no-match → '') from a real error (throw → checkDroppedSymbols fails open) — else every
  // no-match reads as "grep unavailable" and the check goes silently inert.
  const mkGrepTree = (cwd, { cached = false, tree = null } = {}) => (names) => {
    if (!names.length) return '';
    const pat = '(' + names.map(n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    // execFileSync + arg ARRAY (no shell): the pattern reaches `git` verbatim. A shell string was WINDOWS-
    // BROKEN — cmd.exe doesn't treat the POSIX single-quotes as delimiters, so `git grep` searched for the
    // literal quoted string, matched nothing, and Class 6 went silently inert on Windows. Same fix compile-
    // rules.mjs already uses. Grep what each surface ships: Stop → WORKING TREE (`--untracked`, sees new-file
    // callers); pre-commit → INDEX (`--cached`); CI → a TREE-ISH (the PR head). `git grep <tree>` takes
    // neither flag; `tree` is a pre-validated safe ref token.
    const args = tree
      ? ['grep', '-I', '-n', '-E', '-e', pat, tree]
      : ['grep', '-I', '-n', cached ? '--cached' : '--untracked', '-E', '-e', pat];
    try {
      const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      // `git grep <tree>` prefixes every hit `<tree>:path:line:…`. Strip it so classifyHits sees a clean
      // repo-relative path — otherwise the path-PREFIX filters (excludedScanPath / NOISE_PATH `(^|/)dist/`)
      // silently miss (`HEAD:dist/…` has no leading `/`), a false-fire in CI, and the quoted loc is ugly.
      return tree ? out.split('\n').map(l => l.startsWith(tree + ':') ? l.slice(tree.length + 1) : l).join('\n') : out;
    } catch (e) { if (e.status === 1) return ''; throw e; }
  };

  // PostToolUse[Edit|Write] (`--watch-rules`): when a rule-source file (CLAUDE.md / a SKILL.md /
  // ARCHITECTURE.md / SCHEMA.md …) is edited, RECOMPILE the deterministic doc-rules now (into the
  // PROPOSED set — nothing arms until /groundtruth-rules). Sub-second git-grep + regex, no LLM. So a
  // mid-session doc edit takes effect immediately, not only at the next SessionStart.
  if (process.argv.includes('--watch-rules')) {
    let p; try { p = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
    const f = p.tool_input?.file_path || p.tool_input?.path || '';
    const cwd = process.env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
    if (f && RULE_SRC_RE.test(f)) {
      try {
        const n = recompileRules(cwd);
        process.stderr.write(`\n[groundtruth] rule source changed (${f.split('/').pop()}) — recompiled: ${n} rule(s) proposed; run /groundtruth-rules to review + approve.\n`);
      } catch { /* non-fatal */ }
    }
    process.exit(0);
  }

  // `--latest`: print the most recent verdict card to stdout — for watching in your own terminal
  // (`node .claude/hooks/groundtruth.mjs --latest`, or wrap in `watch`/a `while` loop to follow live).
  if (process.argv.includes('--latest')) {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    try {
      const dir = join(cwd, '.claude', 'groundtruth');
      const mds = readdirSync(dir).filter(f => f.endsWith('.md'));
      if (!mds.length) { process.stdout.write('Groundtruth: no verdicts yet.\n'); process.exit(0); }
      const latest = mds.map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
      process.stdout.write(readFileSync(join(dir, latest.f), 'utf8'));
    } catch { process.stdout.write('Groundtruth: no groundtruth dir yet.\n'); }
    process.exit(0);
  }

  // Pre-commit gate (`--pre-commit`, installed as .git/hooks/pre-commit): scan the STAGED diff and
  // surface findings in the terminal BEFORE the commit lands. Unlike Stop (warn-only), this HALTS the
  // commit on block-severity findings (a secret, an RLS-off table, a permissive policy) — the things
  // you must never commit. No agent claim here, so claim-based checks (1/3) naturally don't fire — BUT
  // the Class-6 dangling-ref check runs GATE-FREE (requireClaim:false): a call left resolving to nothing
  // is a broken build regardless of intent, and this is the ONLY hook that sees code PASTED in from a
  // chat (no Stop hook ever fired for a manual paste), so the commit is where it gets caught.
  if (process.argv.includes('--pre-commit')) {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const diff = gitDiffCfg('--cached', cwd);
    if (!diff.trim()) process.exit(0);
    const findings = analyze({ claim: '', diff, cwd }).concat(runCompiledRules(diff, loadCompiledRules(cwd)))
      .concat(collectEnv((a) => git(a, cwd)))
      .concat(checkDroppedSymbols({ claim: '', diff, asks: [], grepTree: mkGrepTree(cwd, { cached: true }), requireClaim: false }));
    if (!findings.length) { process.stderr.write('🟢 Groundtruth: staged diff clean.\n'); process.exit(0); }
    const SEV = { block: '🔴', warn: '🟡' };
    const sorted = [...findings].sort((a, b) => (a.sev === 'block' ? 0 : 1) - (b.sev === 'block' ? 0 : 1));
    process.stderr.write('\nGroundtruth — staged diff:\n' + sorted.map(f => `  ${SEV[f.sev]} [${CLASS_NAME[f.cls] || f.cls}] ${f.msg}`).join('\n') + '\n');
    const blocks = findings.filter(f => f.sev === 'block').length;
    if (blocks) {
      process.stderr.write(`\n🔴 ${blocks} blocking finding(s) — commit HALTED. Fix them, or \`git commit --no-verify\` to override.\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // CI / pre-merge gate (`--diff-range <base>..<head>`): the REAL enforcement boundary (the tool's docs
  // name CI as such — pre-commit is bypassable with `--no-verify` or never installed). Scans a PR range and
  // EXITS NON-ZERO on any block-severity finding OR a Class-6 dangling ref, so the ladder is warn locally
  // (Stop / pre-commit) → BLOCK in the PR, where a human overrides by review, not a solo `--no-verify`.
  // Greps the HEAD tree (what actually merges), no agent claim (Class 6 runs gate-free).
  if (process.argv.includes('--diff-range') || process.argv.some(a => a.startsWith('--diff-range='))) {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const eq = process.argv.find(a => a.startsWith('--diff-range='));
    const raw = eq ? eq.slice('--diff-range='.length) : (process.argv[process.argv.indexOf('--diff-range') + 1] || '');
    const dr = parseDiffRange(raw);
    if (!dr.ok) { process.stderr.write('✗ --diff-range needs a safe git range, e.g. `--diff-range origin/main..HEAD`\n'); process.exit(2); }
    // Silent-inertness guard: a SHALLOW CI checkout (actions/checkout defaults to fetch-depth:1) lacks the
    // base ref → `git diff` errors → the `git` helper swallows it → empty diff → a silent PASS on a broken
    // PR. Verify every endpoint resolves and FAIL LOUD if not (the tool forbids silently inert self).
    for (const ref of dr.range.split(/\.\.\.?/).filter(Boolean)) {
      if (!git(`rev-parse --verify --quiet ${ref}`, cwd).trim()) {
        process.stderr.write(`✗ Ref '${ref}' not found — check out full history in CI (actions/checkout with \`fetch-depth: 0\`). Refusing to scan: an empty diff would silently pass.\n`);
        process.exit(2);
      }
    }
    // Three-dot `A...B` diffs from the MERGE-BASE; unrelated histories (orphan/grafted branches) have none →
    // `git diff A...B` errors → swallowed → empty → silent pass (same sin, different cause). Verify it exists.
    if (dr.range.includes('...')) {
      const [a, b] = dr.range.split('...');
      if (a && b && !git(`merge-base ${a} ${b}`, cwd).trim()) {
        process.stderr.write(`✗ No common ancestor for '${dr.range}' (unrelated histories) — a 3-dot diff can't be computed. Use 2-dot \`${a}..${b}\`, or check out full history.\n`);
        process.exit(2);
      }
    }
    const diff = gitDiffCfg(dr.range, cwd);
    const findings = analyze({ claim: '', diff, cwd }).concat(runCompiledRules(diff, loadCompiledRules(cwd)))
      .concat(checkDroppedSymbols({ claim: '', diff, asks: [], grepTree: mkGrepTree(cwd, { tree: dr.head }), requireClaim: false }));
    if (!findings.length) { process.stderr.write(`🟢 Groundtruth: ${dr.range} clean.\n`); process.exit(0); }
    const SEV = { block: '🔴', warn: '🟡' };
    const fail = findings.filter(f => f.sev === 'block' || f.cls === 6);          // the PR-blocking set
    const sorted = [...findings].sort((a, b) => (fail.includes(b) ? 1 : 0) - (fail.includes(a) ? 1 : 0));
    // Marker matches the DECISION: a Class-6 finding is `sev:'warn'` but blocks in CI → render it 🔴, not 🟡.
    process.stderr.write(`\nGroundtruth — ${dr.range}:\n` + sorted.map(f => `  ${fail.includes(f) ? '🔴' : SEV[f.sev]} [${CLASS_NAME[f.cls] || f.cls}] ${f.msg}`).join('\n') + '\n');
    if (fail.length) {
      process.stderr.write(`\n🔴 ${fail.length} PR-blocking finding(s) (secrets / RLS / dropped-symbol dangling refs) — CI failed. Fix them, or a reviewer can override by merging.\n`);
      process.exit(1);
    }
    process.stderr.write(`\n🟡 ${findings.length} advisory finding(s) — not blocking.\n`);
    process.exit(0);
  }

  // `--install-pre-commit`: write `.git/hooks/pre-commit` so the STAGED-diff scan runs on every `git
  // commit` — the ONLY hook that sees code an agent didn't author (a manual paste from a chat, a
  // hand-edit). The generated hook is fail-open (skips if groundtruth has moved/uninstalled — a stale
  // path must never block commits) and NON-clobbering (won't overwrite a foreign pre-commit hook).
  if (process.argv.includes('--install-pre-commit')) {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const top = git('rev-parse --show-toplevel', cwd).trim();
    if (!top) { process.stderr.write('✗ Not a git repository — nothing to install.\n'); process.exit(1); }
    // `git rev-parse --git-path hooks` resolves the hooks dir in EVERY layout — normal repo, a worktree
    // (where `.git` is a FILE, so `.git/hooks` doesn't exist), and a custom `core.hooksPath`. Hand-rolling
    // `.git/hooks` is wrong in a worktree. Resolve against cwd (git may return a relative path).
    const hooksDir = resolve(cwd, git('rev-parse --git-path hooks', cwd).trim() || join(top, '.git', 'hooks'));
    const target = join(hooksDir, 'pre-commit');
    const self = fileURLToPath(import.meta.url);                            // abs path of THIS groundtruth.mjs (decoded)
    const MARK = 'groundtruth-pre-commit';
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(MARK)) {
      process.stderr.write(`✗ A pre-commit hook already exists and is not Groundtruth's:\n    ${target}\n  Not overwriting. To enable the staged scan, add this line to it:\n    node "${self}" --pre-commit\n`);
      process.exit(1);
    }
    const script = preCommitHookScript(self, MARK);
    try {
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(target, script);
      chmodSync(target, 0o755);
      process.stderr.write(`✓ Installed Groundtruth pre-commit hook → ${target}\n  Scans the STAGED diff on every commit (secrets · RLS · stubs · dropped-symbol dangling refs), halting only on block-severity findings. Bypass once with \`git commit --no-verify\`.\n`);
      process.exit(0);
    } catch (e) { process.stderr.write(`✗ Could not write ${target}: ${e.message}\n`); process.exit(1); }
  }

  // UserPromptSubmit (`--intent`): §7 pre-flight — warn the user when the prompt is too thin to
  // verify completeness, so a later green is known to be lower-confidence. Honesty + rules still hold.
  if (process.argv.includes('--intent')) {
    let p; try { p = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
    const ic = intentConfidence(p.prompt || '');
    if (ic.tier === 'thin')
      process.stderr.write(`\n[groundtruth] ⚠ thin prompt (${ic.reasons.join('; ')}) — Groundtruth will check honesty + rules but NOT completeness. Name a file/component or a test expectation for a full verdict.\n`);
    // The fix for "warn is silent in VS Code": inject the PRIOR turn's findings (persisted by Stop) into
    // THIS turn's context as passive FYI, so the agent sees + triages them instead of a file nobody opens.
    try {
      const cwd = process.env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
      let ctx = '';
      try { ctx = priorFindingsContext(JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', `${p.session_id || 'session'}.findings.json`), 'utf8'))); } catch { /* no prior findings yet */ }
      // Star ask only on a CALM turn (no pending findings) so it never competes with a warn/block note.
      const inject = ctx || starNudge(cwd);
      if (inject) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: inject } }));
    } catch { /* unreadable → inject nothing */ }
    process.exit(0);
  }

  // Audit mode (`node groundtruth.mjs --audit`): standalone debt inventory, no Stop payload.
  if (process.argv.includes('--audit')) {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const findings = auditRepo(cwd, (a) => git(a, cwd)).concat(collectEnv((a) => git(a, cwd)));
    process.stdout.write(renderAudit(findings) + '\n');
    process.exit(0);
  }

  // SessionStart capture (`node groundtruth.mjs --session-start`): snapshot the baseline so Stop can
  // diff against the session's START ref — not HEAD. A session that COMMITS its work would otherwise
  // blind `git diff HEAD` (the real failure the security session exposed). Also records the
  // pre-existing debt so introduced-vs-pre-existing attribution is honest (§5 baseline diffing).
  if (process.argv.includes('--session-start')) {
    let p; try { p = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
    const cwd = process.env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
    try {
      const startRef = (git('rev-parse HEAD', cwd) || '').trim() || 'HEAD';
      const debt = auditRepo(cwd, (a) => git(a, cwd)).map(debtKey);
      const dir = join(cwd, '.claude', 'groundtruth');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${p.session_id || 'session'}.baseline.json`), JSON.stringify({ startRef, debt }));
      // D9: snapshot the referee files' hashes NOW (before the agent acts) so Stop can detect an
      // out-of-band (Bash/MCP) change the diff can't see. Written AFTER baseline so baseline is included.
      writeRefSnapshot(cwd, p.session_id || 'session');
    } catch { /* non-fatal — Stop falls back to HEAD */ }

    // Init at load: (re)compile deterministic rules from ALL declared sources (CLAUDE/AGENTS/SCHEMA/
    // ARCHITECTURE/docs + every .claude/skills/**/SKILL.md + every .claude/agents/*.md) into the
    // PROPOSED set. Only proposes — never arms; `/groundtruth-rules` is the human gate. Now that
    // --watch-rules recompiles on each rule-doc edit too, the rules stay fresh at load AND mid-session.
    try {
      const n = recompileRules(cwd);
      process.stderr.write(`[groundtruth] init: ${n} rule(s) proposed from your docs — run /groundtruth-rules to review + approve (nothing enforces until you do).\n`);
    } catch { /* non-fatal — the last compiled-rules.json stays in effect */ }

    // AGENT INTEGRITY at SessionStart — the ONLY moment this warning can help: subagent definitions are read
    // at session start, so an agent that cannot load is already inert by the time any turn runs, and it fails
    // OPEN (no error, no log). Surfaced here, loudly, per "fail-loud on silent-inertness". Not on the Stop
    // path: these files are long-committed and appear in no diff (16 agents were invisible for weeks).
    try {
      const { agents, docs } = collectAgents(cwd, (a) => git(a, cwd));
      const af = agentFindings(agents, docs);
      if (af.length) {
        process.stderr.write(`[groundtruth] ⚠ ${af.length} subagent problem(s) — these agents CANNOT fire, silently:\n`);
        for (const f of af.slice(0, 8)) process.stderr.write(`  • ${f.msg}\n`);
        if (af.length > 8) process.stderr.write(`  … and ${af.length - 8} more (run \`--audit\` for the full list)\n`);
      }
    } catch { /* non-fatal — never break a session start */ }
    process.exit(0);
  }

  // Run bare in a terminal (no payload piped)? readFileSync(0) would block forever waiting for
  // stdin — so print usage and exit instead of silently hanging. As a Stop hook, stdin is the
  // JSON payload (not a TTY), so this guard never fires in normal operation.
  if (process.stdin.isTTY) {
    process.stderr.write(
      '\ngroundtruth.mjs — Groundtruth Tier-1, a Claude Code Stop hook.\n\n' +
      'It reads a Stop-hook JSON payload on stdin; run bare in a terminal it has nothing to read.\n\n' +
      '  node groundtruth.mjs --audit              scan this repo for debt (no payload needed)\n' +
      '  node groundtruth.test.mjs                 run the self-check\n' +
      '  echo \'{"last_assistant_message":"…"}\' | node groundtruth.mjs   feed a payload manually\n\n' +
      'As a hook it is wired in .claude/settings.local.json and fires automatically on Stop;\n' +
      'verdicts are written to .claude/groundtruth/<session>.md\n');
    process.exit(0);
  }

  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

  // No early-exit on stop_hook_active: the remediation loop must RE-CHECK the agent's fix on each
  // continuation. The attempts cap below (→ escalate) + Claude Code's own consecutive-block ceiling
  // bound it, so it can't run away.

  const cwd = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();

  // ── SubagentStop (v1.1.1): grade the SUBAGENT's claim against the SUBAGENT's own evidence, and touch
  // NOTHING shared. At SubagentStop the payload's transcript_path is the subagent's own file (every entry
  // isSidechain:true) and last_assistant_message is the subagent's "done" — the main path's sidechain
  // filter deleted 100% of that evidence while keeping the claim, so an honest subagent that ran its tests
  // green hit `!ran` ("no test/build command ran"): a structural FP on EVERY test-running subagent. Worse,
  // the shared-session-state writes below ran against the ORCHESTRATOR's contract: <session>.md was
  // overwritten with the subagent's card, the referee snapshot mark advanced (eating the orchestrator's
  // ratification window), tasks.json was rebuilt from the subagent's non-asks, and in block mode the SHARED
  // attempts cap burned with no per-agent state behind it. So this branch parses WITH sidechain included,
  // runs the pure analyze() over the subagent's own tool-ledger diff, and stops: no session.md, no
  // findings.json, no snapshot advance, no tasks.json, no attempts — and NEVER a block decision.
  if (payload.hook_event_name === 'SubagentStop') {
    let sp = null;
    try { sp = parseTranscript(readFileSync(payload.transcript_path, 'utf8'), { includeSidechain: true }); }
    catch { /* unreadable/absent transcript → NO evidence: grading the claim anyway would re-mint the exact
               structural FP this branch removes, so abstain entirely (charter: abstain outside the scope) */ }
    if (!sp) process.exit(0);
    // A transcript that PARSES but yields zero evidence AND zero task text (a 0-byte file mid-flush, a
    // foreign-schema harness) is the same no-evidence case as an unreadable one: grading the claim against
    // nothing re-mints the exact !ran FP this branch removes (verified: an empty transcript + "all tests
    // pass" warned). A real subagent transcript always carries at least its task prompt (intent), so a
    // genuinely lazy subagent — prompt present, no test run — is still graded and still caught.
    if (!sp.intent && !sp.bashCmds.length && !sp.results.length && !sp.toolDiff && !sp.mutations.length) process.exit(0);
    const findings = analyze({
      claim: payload.last_assistant_message || '',
      // Content scanners see the subagent's OWN authored writes (its tool ledger) — not the session git
      // diff, which is the orchestrator-baseline's whole tree and is re-scanned at the main Stop anyway.
      // gitDiff:'' keeps AG-B/AG-C abstaining here: the ledger replays a file's unchanged context lines as
      // `+`, their known pre-existing-skip-reads-as-added FP vector (see the gDiff routing note in analyze).
      diff: dropExcludedFiles(sp.toolDiff || ''), gitDiff: '',
      bashCmds: sp.bashCmds, results: sp.results, cwd, bgPending: sp.bgPending,
      bashEvents: sp.bashEvents, mutations: sp.mutations,
    // Warn-only STRUCTURALLY, regardless of GROUNDTRUTH_BLOCK: the remediation loop's attempts counter is
    // per-session, so a subagent block would burn the orchestrator's cap (2 → escalate) against a contract
    // that isn't the orchestrator's. Demote in the findings themselves — a real block-tier catch (a secret
    // in the ledger) regains its tier at the orchestrator's Stop, which re-scans the same tree.
    }).map(f => f.sev === 'block' ? { ...f, sev: 'warn' } : f);
    // intent:'' on purpose → Completeness renders ⚪ n/a: the subagent's "user" turns are the orchestrator's
    // task text, and grading completeness against a prompt the human never typed would be a phantom contract.
    const card = renderCard(findings, { session: `${payload.session_id || 'session'} (subagent)`, intent: '', blockEnabled: false });
    process.stderr.write('\n' + card + '\n');
    console.log(JSON.stringify({ systemMessage: card }));
    process.exit(0);
  }

  // Baseline diffing: diff against the session's START ref (captured at SessionStart) so committed
  // work is still seen; fall back to HEAD when no baseline was captured.
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', `${payload.session_id}.baseline.json`), 'utf8'));
  } catch { /* no baseline */ }
  const baseRef = baseline?.startRef || 'HEAD';
  let diff = gitDiffCfg(baseRef, cwd);
  const gitOnlyDiff = diff;   // capture BEFORE the tool-ledger/untracked merge — AG-B/AG-C need real -/+ pairing

  let parsed = { intent: '', bashCmds: [], results: [] };
  if (payload.transcript_path) {
    try { parsed = parseTranscript(readFileSync(payload.transcript_path, 'utf8')); } catch { /* fail-open */ }
  }
  // Merge the tool-call Diff Ledger (Edit/Write/MultiEdit reconstructed from the transcript) into the
  // git diff ALWAYS — not only as a no-git fallback. `git diff <ref>` ignores NEW untracked files, so
  // a file the agent just CREATED this session was invisible to every diff-based check and the
  // silent-no-op (Class 3) falsely flagged it as "claimed but absent from the diff". The ledger holds
  // exactly this session's writes, so merging it makes new files visible without `git add` side effects.
  if (parsed.toolDiff) diff += (diff.trim() ? '\n' : '') + parsed.toolDiff;
  // REALITY blind-spot fix: a secret/RLS/stub written through a channel the tool-ledger doesn't see — a
  // Bash redirection (`printf > leak.js`, heredoc, sed) or any new file the Write/Edit tools didn't
  // author — is UNTRACKED, so `git diff` misses it and a live key reads as a 0-line diff. Pull every
  // untracked file's ACTUAL on-disk content into a WIDER scan reality (disk is ground truth), plus any
  // SQL an MCP DB tool ran (apply_migration/execute_sql — leaves no file at all). This feeds the SECURITY
  // scanners ONLY: reading untracked CONTENT into the ledger's diff would false-ground a task 'done' on
  // any prose mention of its filename (e.g. the transcript). So `diff` (authored changes) drives the
  // ledger / open-loops / tamper; `scanDiff` (authored + untracked + MCP) drives analyze's content checks.
  const ut = untrackedAdded(cwd, new Set(changedFiles(diff)));
  // dropExcludedFiles: the content checks (secrets/stubs/rules/phantom) never scan GT's own state or an
  // out-of-repo throwaway (scratchpad/tmp/absolute) — those reach the scan only via the tool-ledger and are
  // not deliverables. The ledger/open-loops keep the UNfiltered `diff` (namedDeliverables already excludes
  // scratchpad), so this only narrows the content scanners.
  const mcpFrag = parsed.mcpSql ? `\n+++ b/<mcp-sql>\n` + parsed.mcpSql.split('\n').map((l) => '+' + l).join('\n') : '';
  const scanDiff = dropExcludedFiles(diff + ut.content + mcpFrag);

  const findings = analyze({
    claim: payload.last_assistant_message || '',
    diff: scanDiff, gitDiff: gitOnlyDiff, bashCmds: parsed.bashCmds, results: parsed.results, cwd, bgPending: parsed.bgPending,
    // v1.1.0 paired+ordered transcript evidence (exit status / stale green / filtered runs). ONLY the Stop
    // path has a transcript, so only it passes these — --pre-commit and --diff-range leave them null and the
    // checks abstain there by construction (no ordering, no exit codes → never fire, never bless).
    bashEvents: parsed.bashEvents, mutations: parsed.mutations,
  });

  // H2: an untracked file too large to fully scan is surfaced, never silently dropped (a secret padded
  // past the cap can't buy a green — "can't fully see it" reads amber, not benign). No `rule` field: that
  // key is reserved for genuine compiled-rule ids (the card prints [id] + a `/groundtruth-rules unarm <id>`
  // hint from it), and this built-in coverage-gap isn't unarmable via that command.
  for (const f of ut.oversized) findings.push({ cls: 'R', sev: 'warn',
    msg: `untracked file not fully secret-scanned — ${f}` });   // `f` carries the reason (per-file cap hit, or total budget exhausted)

  // §10: also evaluate the deterministic rules compiled from this repo's own docs (CLAUDE.md/skills).
  // AUTHORED reality only (git + tool ledger + MCP SQL) — NOT scanDiff. Compiled rules grade the agent's
  // CHANGES ('forbid_in_added', "never commit X"), and scanDiff's untracked-content merge includes
  // pre-existing BYSTANDER files nobody touched this session. LIVE FP (real hindsight session): the
  // no-commit-local-only-files rule fired 🔴 on scripts/dev-server.mjs — a file never committed, never
  // staged, never edited, merely PRESENT untracked in the working tree — because its on-disk shebang line
  // entered scanDiff as an "added" line and the rule's line_re (\S) matched it. Presence is not a change.
  // Accepted trade (warn-FN over false-🔴): a NEW file authored via a Bash heredoc now dodges doc rules —
  // the security scanners still see it through scanDiff, and the pre-commit/CI gates re-check the real diff.
  findings.push(...runCompiledRules(dropExcludedFiles(diff + mcpFrag), loadCompiledRules(cwd)));

  // Class 6 — a dropped symbol left dangling under a preservation claim (symbol-integrity.mjs). Claim-gated
  // here (the Stop-hook honesty run); the pre-commit path runs it gate-free. `scanDiff` (not `diff`) so a
  // Bash-moved def is seen; grep searcher is the shared `mkGrepTree` (exit-1→'' vs throw→fail-open).
  findings.push(...checkDroppedSymbols({ claim: payload.last_assistant_message || '', diff: scanDiff, asks: parsed.asks || [], grepTree: mkGrepTree(cwd) }));

  // §11: tamper-evidence — did THIS turn rewrite the referee's own ground truth (rules/config/ledger)?
  // Severity anchors to ENV block authority, never to config.json (which the agent may have just
  // rewritten); a write ratified by the matching slash-command is legitimate. See refereeTamper.
  const envBlock = process.env.GROUNDTRUTH_BLOCK === '1';
  findings.push(...refereeTamper(diff, parsed.commandsInvoked || new Set(), envBlock));

  // v2 claims contract — the honesty/completeness engine (v2.0.0: ON by default; opt OUT with
  // GROUNDTRUTH_CONTRACT=0 for the legacy prose path, which is being retired). NC/CA/UC replace the prose
  // class-1/class-3 claim detection and the prose task ledger. Reality is read from the AUTHORED `diff`
  // (git + tool ledger, so untracked creates are seen) and the transcript's bash evidence; symbols are
  // lexed per-file from scanDiff. Fully fail-open: the contract path must never break a turn.
  if (process.env.GROUNDTRUTH_CONTRACT !== '0') {
    try {
      const reality = buildReality({
        diff, cwd,
        // pass bashEvents THROUGH (may be undefined on the fail-open / no-transcript path) so a truthful
        // tests_pass claim ABSTAINS there instead of becoming a false CA; an empty array = a real "nothing ran".
        bashEvents: parsed.bashEvents,
        symbolsByFile: addedSymbolsByFile(scanDiff),
        excluded: (p) => excludedScanPath(p),
        // UC/NC are scoped to files the agent's Write/Edit tools actually authored (relativized in
        // buildReality), so a dirty tree / manual edit / lockfile churn the agent can't declare is never a
        // false UC. ACCEPTED BOUND (Fable re-review): a file the agent edits through the BASH channel
        // (`sed -i`, `> f`, heredoc) is not in the Write/Edit ledger, so an undeclared Bash-channel change
        // escapes UC/NC — the same tool-ledger blind spot the security scanners already accept (see the
        // scanDiff note above); the CI/pre-merge `--diff-range` gate, which has the full diff and no ledger
        // dependency, is the backstop. Chosen precision-first over the whole-diff scope's dirty-tree FPs.
        authored: (parsed.mutations || []).map(m => m.path),
        // the "last source edit" seq for the stale-green sensor (computed with the code-only/relativized gates).
        lastEditSeq: lastCodeEditSeq(parsed.mutations || [], cwd),
        // DISK-PRESENCE gate for the synthetic-`A` mint: the untracked (`??`) path set. Distinguishes a real
        // new file (untracked-present) from an edit-then-revert (tracked, gone from the diff) and a Write-then-
        // rm (absent), so a `created` claim verifies against what's actually on disk. (Fable adv FP-5/FN-5/FP-8.)
        untracked: ut.paths,
        // commands the filtered SIDECHAINS ran → a tests_pass claim backed only by a subagent's run ABSTAINS
        // (not a block-tier "no such command ran"). (Fable adv FP-10.)
        sidechainCmds: parsed.sidechainCmds,
        // MULTI-TURN deferrals (spec §6): reconstruct the still-OPEN set from EVERY past turn's contract in
        // the transcript (the unforgeable record), so a declared set-aside can't silently vanish by being
        // omitted next turn. The current turn's message is appended in case it hasn't flushed to the file yet.
        openDeferrals: (() => {
          const texts = [...(parsed.assistantTexts || [])];
          const last = payload.last_assistant_message || '';
          if (last && texts[texts.length - 1] !== last) texts.push(last);
          const contracts = texts.map(t => analyzeContract(t)).filter(a => a && a.ok).map(a => a.contract);
          return openDeferrals(contracts);
        })(),
      });
      findings.push(...contractFindings(payload.last_assistant_message || '', reality));
    } catch { /* fail-open — v1 verdict stands */ }
  }
  // D9: DEFENSE-IN-DEPTH for the indirect case (a sub-script writes a referee file, so no command names
  // it) — compare current hashes against the SessionStart snapshot. The TRANSCRIPT scan above is the
  // primary anchor; this catches the effect when the action was laundered through another file.
  {
    const sess = payload.session_id || 'session';
    const snap = loadVerifiedSnapshot(cwd, sess);
    const keyConfigured = !!(process.env.GROUNDTRUTH_KEY || '');
    if (snap) {
      const cur = snapHashes(cwd, sess);
      const invocations = parsed.commandInvocations || [];
      const fresh = freshRatifiers(invocations, snap.mark);              // ratifiers invoked THIS interval only
      findings.push(...compareSnapshot(snap, cur, fresh, envBlock, keyConfigured));
      // Advance the baseline for the NEXT turn: legit (unchanged / ratified-this-interval) targets move
      // forward — and the mark advances past this turn's commands — so a ratifier can't excuse a FUTURE
      // out-of-band change; an unratified change is HELD at the old hash so it keeps firing until reverted.
      // Skip a forged snapshot (sigValid===false): leave it flagging, don't re-bless it. The hook holds the
      // env key; the agent's shell (key held out) can't re-sign, so it can't forge this re-snapshot.
      if (snap.sigValid !== false) {
        const adv = advanceSnapshot(snap.files, snap.observed, cur, snapshotTargets(sess), fresh);
        writeRefSnapshot(cwd, sess, invocations.length, adv.files, adv.observed);
      }
    } else if (baseline) findings.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn',
      // H1: the snapshot is written right after the baseline at SessionStart, so baseline-present +
      // snapshot-ABSENT means the agent DELETED it (deletion beats the HMAC seal). "Can't see it" must
      // read RED here, not benign-skip — that conflation was the disarm. (No baseline → SessionStart
      // never ran → genuinely nothing to compare, no false alarm.)
      msg: 'referee integrity snapshot is MISSING while the baseline exists — it is written at SessionStart, so its absence means it was deleted; verdict integrity NOT guaranteed' });
  }
  // D8: with NO baseline, the hook diffs against HEAD — so anything COMMITTED this session is invisible to
  // every check (a committed secret reads as a clean diff). BUT a missing baseline only HIDES something when
  // work was actually committed; with no commit, HEAD IS the current state and the diff loses nothing. So
  // fire ONLY on real committed-this-session work. A baseline absent because SessionStart never ran (plugin
  // reinstalled mid-session, hook unwired) with no commits is BENIGN — it's already noted on the ⚪ Debt
  // line, and blocking it was the live FP that escalated a clean session. The committed-work hazard's true
  // enforcement is CI anyway (deterministic baseline there, no mid-session reinstall).
  if (!baseline && sessionHasCommit([...(parsed.bashCmds || []), ...(parsed.mcpCmds || [])]))
    findings.push({ cls: 'tamper', sev: envBlock ? 'block' : 'warn',
      msg: 'no session baseline AND a commit ran this session — committed work is invisible to every check (the hook is diffing against HEAD); ensure the SessionStart hook ran, or restore the deleted baseline.json' });

  // Completeness (v2): the prose task ledger is retired. The contract's own passes cover it deterministically
  // — UC catches a change the agent didn't declare, CA catches a declared deliverable that never landed, and
  // a `deferred` claim surfaces (above, via contractFindings) as the agent's declared set-aside. No prose
  // extraction, no persisted tasks.json to forge — declaration replaces guessing (spec §6).

  // Procedural compliance: did the agent follow this project's declared step-procedures (required /
  // forbidden / ordered commands) over its tool calls? Grounded in the transcript order, no LLM.
  findings.push(...runProcedures([...(parsed.bashCmds || []), ...(parsed.mcpCmds || [])], loadProcedures(cwd)));

  // Security: env files that are committed or not gitignored (secret-leak risk). git-grounded, repo-wide.
  findings.push(...collectEnv((a) => git(a, cwd)));

  // §5 attribution: scan ONLY the changed files (cheap) for debt, split introduced vs pre-existing
  // against the baseline snapshot. Introduced = this session's; pre-existing = noted, not blamed.
  let baselineInfo = null;
  if (baseline) {
    const changedDebt = changedFiles(diff).flatMap(f => {
      try { return scanContent(f, readFileSync(join(cwd, f), 'utf8'), cwd); } catch { return []; }
    });
    const { introduced } = attributeDebt(baseline.debt, changedDebt);
    baselineInfo = { ref: baseRef, preExisting: (baseline.debt || []).length, introduced: introduced.length };
  }

  // Manual edits to a rule doc bypass --watch-rules (a TOOL hook), so refresh the PROPOSED set here when a
  // hand-edited CLAUDE.md/SKILL.md/… is newer than proposed-rules.json — reflected THIS turn (the card's
  // pending-approvals nudge below picks it up), not only at the next SessionStart. PROPOSED only; nothing
  // arms without /groundtruth-rules. Cheap (ls-files + stat), recompiles ONLY when stale, fail-open.
  try {
    const mtime = (p) => { try { return statSync(join(cwd, p)).mtimeMs; } catch { return null; } };
    const srcs = git('ls-files', cwd).split('\n').filter(f => RULE_SRC_RE.test(f));
    if (proposedStale(mtime('.claude/groundtruth/proposed-rules.json'), srcs.map(mtime))) recompileRules(cwd);
  } catch { /* non-fatal — proposed set just stays as-is until SessionStart */ }

  // Block is opt-in, default warn. Either source enables it (no settings.json edit required):
  //   env GROUNDTRUTH_BLOCK=1  (back-compat)   OR   .claude/groundtruth/config.json {"block":true}
  const blockEnabled = process.env.GROUNDTRUTH_BLOCK === '1' || loadGtConfig(cwd).block === true;
  const card = renderCard(findings, { session: payload.session_id || 'unknown', intent: parsed.intent, blockEnabled, baseline: baselineInfo, pendingRules: pendingApprovals(cwd), integrity: integrityScope(!!(process.env.GROUNDTRUTH_KEY || '')) });

  // Hoisted so the block/escalate branch below can re-persist findings.json with the outcome marker (the
  // never-lost floor) — dir/sid/surf must be in scope past the try.
  const dir = join(cwd, '.claude', 'groundtruth');
  const sid = payload.session_id || 'session';
  const surf = projectFindings(findings);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.md`), card + '\n');
    // persist surfaceable findings so the next UserPromptSubmit (--intent) injects them into the agent's
    // context — the .md alone is read by no one in VS Code (the silent-warn gap). Overwritten every turn.
    // Inject only NON-quiet warn/block findings: nag-once means a hard task already surfaced in a prior turn
    // still shows on the card (f.quiet stays in `findings`) but is NOT re-injected into the agent's context.
    writeFileSync(join(dir, `${sid}.findings.json`), JSON.stringify(surf));
    // cumulative history — one line per turn, never overwritten (weekly harvest)
    try {
      const rec = { ts: new Date().toISOString(), session: sid,
        verdict: findings.some(f => f.sev === 'block') ? 'block' : findings.length ? 'warn' : 'clean',
        findings: surf };
      writeFileSync(join(dir, 'history.jsonl'), JSON.stringify(rec) + '\n', { flag: 'a' });
    } catch {}
  } catch { /* non-fatal */ }

  process.stderr.write('\n' + card + '\n');

  // Surface the verdict IN the user's window every turn (not just the .md): plain Stop-hook stdout is
  // debug-only, so use the JSON `systemMessage` channel. suppressOutput hides the raw JSON line itself.
  // systemMessage = user-facing (free; VS Code may not render it). NO additionalContext — injecting
  // the card into the model's next turn made it reply UNPROMPTED. View via `--latest` / the .md.
  const out = { systemMessage: card };

  // Remediation loop: block a FIXABLE catch (sev:block — async_done/warns excluded), hand back the
  // corrective payload, retry-cap at 2, then escalate (never wedge). Fail OPEN on any fs error.
  const blockFindings = blockEnabled ? findings.filter(f => f.sev === 'block') : [];
  const attemptsFile = join(cwd, '.claude', 'groundtruth', `${payload.session_id || 'session'}.attempts`);
  if (blockFindings.length) {
    let attempts = 0;
    try { attempts = parseInt(readFileSync(attemptsFile, 'utf8'), 10) || 0; } catch {}
    // anti-gaming: a RETRY (attempts>0) that edits the tests or the groundtruth ledger is attacking the
    // check to turn it green → KEEP the block and flag a human (gaming must not be an escape hatch).
    const gamed = attempts > 0 && changedFiles(diff).some(f => GAMED_FILE_RE.test(f));
    const d = remediationDecision({ attempts, gamed });
    let wrote = true;
    try { writeFileSync(attemptsFile, String(d.nextAttempts)); } catch { wrote = false; }
    // Never-lost floor: persist the EFFECTIVE outcome (a block whose counter-write failed degrades to
    // escalate) so the next-turn banner surfaces it even if every live channel (systemMessage/reason) is
    // dropped. Written AFTER the plain surf so the marker leads the next turn's note.
    const effective = (d.action === 'block' && wrote) ? 'block' : 'escalate';
    const note = blockOutcomeNote(effective, effective === 'block' ? d.nextAttempts : attempts, 2, d.gamed);
    if (note) { try { writeFileSync(join(dir, `${sid}.findings.json`), JSON.stringify([note, ...surf])); } catch {} }
    // Live pop — best-effort, DETACHED + fail-open. Deduped PER CATCH (fire on the first block or on escalate,
    // not on intermediate retries) so a loop doesn't spam. Missing binary → the 'error' handler swallows it;
    // the never-lost banner is the guarantee, this is only the in-the-moment surface.
    // Suppress the live pop for a throwaway repo under the OS temp dir (the redteam/test harnesses, which
    // would otherwise spray editor tabs). CI needs no gate — it has no display, so the pop fails open there.
    // The never-lost banner still records the outcome regardless.
    const ephemeral = dir === tmpdir() || dir.startsWith(tmpdir() + sep);   // sep guard: `/tmpfoo` must not match `/tmp`
    if ((effective === 'escalate' || attempts === 0) && !ephemeral) {
      try {
        const plans = liveNoticeCmds(effective, join(dir, `${sid}.md`), process.platform, editorCli(), process.env);
        for (const p of plans) { const ch = spawn(p.cmd, p.args, { detached: true, stdio: 'ignore' }); ch.on('error', () => {}); ch.unref(); }
      } catch { /* never let a notice stall or crash the hook */ }
    }
    if (d.action === 'block' && wrote) {
      out.decision = 'block';
      out.reason = (d.gamed ? '⚠ GAMING DETECTED — a fix attempt edited the tests / this checker / the ledger. The block HOLDS; it is not an escape hatch. A human must review.\n\n' : '') + renderCorrective(blockFindings, d.nextAttempts);
    } else {
      out.systemMessage = card + `\n\n  🔴 ESCALATE — ${wrote ? d.why : 'cannot track attempts'}. Groundtruth is not blocking further; human review needed.`;
    }
  } else {
    // clean (or block disabled): the catch is resolved → reset the counter for the next one
    try { if (existsSync(attemptsFile)) writeFileSync(attemptsFile, '0'); } catch {}
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
