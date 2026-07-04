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
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, chmodSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';   // NOT `new URL(...).pathname` — that percent-encodes spaces (`john doe`→`john%20doe`), silently inerting every path-derived check on a spaced/Windows/cloud-synced install
// Class 6 lives in its own module (this engine is already large). The import is a deliberate cycle
// (symbol-integrity.mjs re-imports the pure lexers below) — safe because every cross-reference is at
// call time, never at module-eval time.
import { checkDroppedSymbols } from './symbol-integrity.mjs';

const CLASS_NAME = { 1: 'false test/build claim', 2: 'stub/placeholder', 3: 'silent no-op', 4: 'phantom ref',
  6: 'dropped symbol (dangling ref)', 9: 'special-casing / overfit', async_done: 'false completion (async)',
  B1: 'RLS off on new table', B3: 'permissive policy (anon-readable)', C1: 'hardcoded secret', C2: 'private key',
  R: 'compiled rule (from your docs)', openloop: 'open loop (asked, not delivered)', P: 'procedure (step skipped / out of order)',
  ENV: 'env file not gitignored (secret-leak risk)' };
const CLASS_BUCKET = { 1: 'Ignored', 2: 'Missed→Ignored', 3: 'Ignored', 4: 'Missed', 6: 'Missed→Ignored', async_done: 'Ignored',
  B1: 'Ignored', B3: 'Ignored', C1: 'Ignored', C2: 'Ignored', R: 'Ignored' };

// Phase-1 false-completion (async): the claim asserts done/clean AND simultaneously says the work is
// still running/deferred — a self-contradiction. Conservative: fires only when BOTH are present, so a
// plain "Done!" (no deferral) abstains (precision guard, spec §9). Warn-only — a false "you lied" is
// worse than a miss.
const COMPLETION_RE = /\b(done|complete[ds]?|finished|shipped|delivered|all set|wrapped up|clean)\b|✓|🟢|told\s*&\s*done/i;
const DEFERRAL_RE = /\b(in progress|still running|running in the background|in the background|background (?:workflow|run|job|task|agent)|i'?ll (?:deliver|continue|report|update|finish|send|hand)|when it (?:completes?|lands?|finishes?|returns?)|waiting on|watch[^.]{0,20}\/workflows|will (?:notify|deliver|update you)|kicked off|once (?:it|the run|the workflow))\b/i;

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
// A test RESULT that clearly reports failures, across runners (JS/TAP, Go, Cargo, pytest, RSpec, JUnit/Maven).
const TEST_FAIL_RE = /\b\d+\s+(?:failing|failed|failures?)\b|\bAssertionError\b|\bnot ok \d|Tests?:\s*\d+\s+(?:failed|failing)|(?:^|\s)FAIL\b|---\s*FAIL:|test result:\s*FAILED|\b\d+\s+examples?,\s*[1-9]\d*\s+failures?|Tests run:\s*\d+,\s*Failures:\s*[1-9]|\bpanicked\b/i;
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
const EVALUATOR_DETECT_RE = /GROUNDTRUTH_[A-Z]\w*|groundtruth[-_](?:ok|off|skip|disable|ignore)|process\.env\.CI\b|process\.env\.\w*_?ENV\s*===?\s*['"]test|os\.environ(?:\.get\(|\[)\s*['"](?:CI|PYTEST)|ENV\[['"](?:CI|RAILS_ENV)|\bif\b[^;\n]{0,40}\b(?:is_?test|under_?test|in_?test|testing_?mode)\b/i;

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

/**
 * Pure deterministic Tier-1 analysis. Returns findings[].
 * ctx: { claim, diff, bashCmds:[cmd], results:[{is_error, text}], cwd }
 */
export function analyze({ claim = '', diff = '', bashCmds = [], results = [], cwd = process.cwd(), bgPending = false }) {
  const findings = [];
  const files = changedFiles(diff);
  const added = diff.split('\n').filter(l => l[0] === '+' && !l.startsWith('+++'));

  // Class 1 — false test/build claim
  // Only a real, POSITIVE assertion counts. The claim's noun+verb must share a SENTENCE (the gap excludes .!?
  // so "Great tests! They should pass" isn't read as one claim), and exclusions are scoped to that sentence —
  // a hypothetical in a LATER sentence can't silence a real claim ("Tests pass. If you change X, make sure the
  // build passes."). Exclusions:
  //   (a) a modal OR negation within 3 words of the verb ("tests should pass", "tests don't pass yet") — the
  //       guard's verb set MIRRORS the claim's (…|verified|all clean), else "should be VERIFIED" leaks as a block;
  //   (b) a counterfactual whose marker PRECEDES the claim ("even if I'd watched … go green") — a TRAILING
  //       "…even if you retry" / "…would have failed" clause must NOT launder a leading real claim, so (b) is
  //       tested only on the sentence PREFIX up to the claim.
  // We scan ALL matches (global) and take the FIRST that survives the exclusions — so a hedged EARLIER
  // sentence ("The build should pass once wired. The tests pass.") can't shadow a real claim that follows.
  const VERB = String.raw`(?:pass(?:e[ds])?|green|succeed(?:ed)?|verified|all clean)`;
  const nearModalOrNeg = new RegExp(String.raw`\b(?:should|would|must|will|[’']ll|to|need(?:s|ed)?\s+to|can|could|may|if|once|when|make sure|ensure|so that|not|never|no|\w*n[’']t)\b(?:\s+\w+){0,3}\s+` + VERB, 'i');
  const counterfactual = /\b(?:even\s+if|if\s+\w+[’']d|if\s+\w+\s+had|would(?:[’']ve|\s+have)|had\s+i)\b/i;
  // A quoted PATTERN, not prose — "tests/build … pass/green", "pass(?:e[ds])?|green" — is Groundtruth's own
  // regex being discussed, not a claim. Tell: a slash/pipe with a VERB keyword on AT LEAST ONE side, or regex
  // group syntax. (Real prose slashes nouns and leaves the verb bare — "Build/tests pass" is a claim; meta
  // slashes the verb pair — "pass/green" is a quote.)
  const V = String.raw`(?:pass\w*|green|succeed\w*|verified|clean)`;
  const K = String.raw`(?:tests?|build|lint|check|typecheck|pass\w*|green|succeed\w*|verified|clean)`;
  const quotedPattern = new RegExp(`${V}\\s*[\\/|]\\s*${K}|${K}\\s*[\\/|]\\s*${V}|\\(\\?[:=!<]`, 'i');
  let _passClaim = null;
  for (const m of claim.matchAll(/\b(tests?|build|lint|typecheck|type-check)\b[^.!?\n]*\b(pass(?:e[ds])?|green|succeed(?:ed)?|verified|all clean)\b/gi)) {
    if (quotedPattern.test(m[0])) continue;                          // a quoted pattern, not a claim
    const before = claim.slice(0, m.index);
    const sentBefore = before.slice(before.search(/[^.!?\n]*$/));    // the claim's sentence, up to the claim
    const after = claim.slice(m.index);
    const sentence = sentBefore + after.slice(0, (after.search(/[.!?\n]/) + 1) || after.length);
    if (nearModalOrNeg.test(sentence) || counterfactual.test(sentBefore)) continue;   // hedged / negated / counterfactual
    _passClaim = m; break;                                           // first surviving real claim
  }
  if (_passClaim) {
    const ev = ` ("${_passClaim[0].trim().slice(0, 60)}")`;   // quote what matched, so a false positive is obvious
    const testHits = bashCmds.filter(c => TEST_BUILD_RE.test(c));
    const ran = testHits.length > 0;
    // Failure = a TEST RESULT that clearly reports failures — NOT any errored tool / stray ✗ / "Error:"
    // anywhere in the noisy session (that breadth caused the false block). Narrow + warn-only (heuristic).
    const failed = results.some(r => TEST_FAIL_RE.test(r.text));
    // A "tests pass" claim backed ONLY by a syntax/type check (node --check, tsc, cargo check, …) is the
    // ESM-class trap: raw-node / compile green ≠ the runtime that actually ships. Warn (not block) — the noun
    // is specifically "tests", so FP is low, but a legit tsc-as-test turn shouldn't halt. Split on shell
    // separators + anchor at segment start, and allow the real-world prefixes agents use (`npx tsc`,
    // `./node_modules/.bin/tsc`, `FOO=1 tsc`), while `tsc(?=\s|$)` keeps `node tsc-x.test.mjs` (tsc in a
    // filename) and `npm test && tsc` (a real run in the same string) from being mistaken for a bare check.
    const WEAK_CHECK_RE = /^\s*(?:\w+=\S+\s+)*(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn)\s+)?(?:\S*\/)?(?:node --check|node\s+-e\b|tsc(?=\s|$)|deno check|cargo check|go vet|py_compile|ruby -c\b)/;
    const weakOnly = c => { const ts = c.split(/&&|\|\|?|;/).filter(s => TEST_BUILD_RE.test(s)); return ts.length > 0 && ts.every(s => WEAK_CHECK_RE.test(s)); };
    const onlyWeak = ran && testHits.every(weakOnly);
    if (!ran) findings.push({ cls: 1, sev: 'block', msg: `claimed tests/build pass${ev}, but no test/build command ran this session` });
    else if (/^tests?$/i.test(_passClaim[1]) && onlyWeak) findings.push({ cls: 1, sev: 'warn', msg: `claimed tests pass${ev}, but only a syntax/type check ran (${testHits[0].trim().slice(0, 40)}) — that is not a test run; verify in the runtime that ships` });
    else if (failed) findings.push({ cls: 1, sev: 'warn', msg: `claimed tests/build pass${ev}, but a test run looks like it reported failures — double-check` });
    // Anti-gaming: claimed green, but the ONLY files changed are tests → the test may have been
    // weakened to pass instead of the code being fixed. Warn-only (heuristic) so a legit
    // test-writing turn is never blocked. Fires only when the whole diff is test files.
    const isTest = f => TEST_FILE_RE.test(f);
    const testFiles = files.filter(isTest);
    if (testFiles.length && files.every(isTest))
      findings.push({ cls: 1, sev: 'warn', msg: `claimed pass, but the only files changed are tests (${testFiles.map(f => f.split('/').pop()).join(', ')}) — verify the test wasn't weakened instead of the code fixed` });
  }

  // async_done — claimed done/clean while the work is actually unfinished. Two grounds: the claim
  // CONTRADICTS itself (says still-running/deferred), OR a background task was launched this session
  // with no completion record (bgPending, from the transcript) — the disk-grounded recall path.
  if (COMPLETION_RE.test(claim) && (DEFERRAL_RE.test(claim) || bgPending))
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

  // Class 3 — silent no-op: claim names a file in PAST-TENSE ACTION voice, but it's absent from
  // the diff. Past-tense-verb gating (not every filename) is the precision fix — a file merely
  // *read* for context is mentioned in prose and must NOT flag.
  const seen = new Set();
  // The `(?![\w])` after the extension group is load-bearing: JS alternation is leftmost-wins (not
  // longest-match) and a shorter ext can prefix a longer one (`js`<`json`/`jsx`, `ts`<`tsx`, `c`<`cpp`),
  // so without a trailing boundary a claim about `config.json` would capture `config.js` (truncated) and
  // then false-flag it absent. The lookahead forbids mid-token truncation regardless of alternation order
  // — which is what makes the broad SRC_EXT safe to interpolate here.
  const C3_RE = new RegExp('\\b(?:created|added|updated|wrote|modified|changed|fixed|removed|deleted|renamed|refactored|extracted)\\b[^.\\n]*?([\\w./-]+\\.(?:' + SRC_EXT + '))(?![\\w])', 'gi');
  for (const m of claim.matchAll(C3_RE)) {
    const named = m[1];
    if (seen.has(named)) continue;
    seen.add(named);
    // A tool-file / non-repo path (proposed-rules.json, .claude/groundtruth/*, tmp|scratch, …) is GITIGNORED
    // or ephemeral, so it can NEVER appear in a git diff — a past-tense mention (common when the work IS on
    // Groundtruth's own docs/commands that read these files) would then ALWAYS false-flag as a no-op. The
    // Completeness path already excludes these via NONREPO_OR_TOOL; apply the same here. (Corpus FP, session 79e00f4c.)
    if (NONREPO_OR_TOOL.test(named)) continue;
    // basename match only — a bare `f.endsWith(named)` would let an unrelated `app/xconfig.js` satisfy a
    // claim about `config.js` (suffix-substring with no path boundary) and SUPPRESS a real no-op.
    // Case-insensitive: a claim about `schema.md` must match the repo's `SCHEMA.md` (else a false no-op).
    const nl = named.toLowerCase();
    if (!files.some(f => { const fl = f.toLowerCase(); return fl === nl || fl.endsWith('/' + nl); }))
      findings.push({ cls: 3, sev: 'warn', msg: `claimed a change to ${named}, but it is absent from the diff` });
  }

  // Class 4 — phantom ref (best-effort, WARN only): a NEW relative import whose target file is
  // absent from the working tree, resolved against the importing file's own directory. Bare/package
  // specifiers are skipped (can't resolve cheaply).
  // NOTE: best-effort + WARN-only — file-existence resolution, not full symbol resolution. Upgrade to
  // proper resolution (a real resolver, or the roadmap LLM layer) only if this misses real phantom refs.
  let curFile = '', curLang = null, curSrc = false, sawC9 = false;
  for (const l of diff.split('\n')) {
    const h = l.match(/^\+\+\+ b\/(.+)$/);
    if (h) { curFile = h[1] === '/dev/null' ? '' : h[1]; curLang = curFile ? importLang(curFile) : null;
             curSrc = !!curFile && CODE_EXT_RE.test(curFile) && !TEST_FILE_RE.test(curFile); continue; }
    if (l[0] !== '+' || l.startsWith('+++') || !curFile) continue;
    if (curLang) {                                                               // Class 4 — phantom ref (import langs only)
      const m = l.match(curLang.re);
      // Real import only if the KEYWORD survives string-blanking at its position — an import-shaped substring
      // INSIDE a string literal (`const d = "+import x from './h'"`, a test fixture) is not a real import.
      if (m && blankStrings(l)[m.index] !== ' ' && !relImportResolves(cwd, curFile, m[1], curLang.suffixes))
        findings.push({ cls: 4, sev: 'warn', msg: `new import may not resolve: ${m[1]} (in ${curFile})` });
    }
    if (curSrc && !sawC9 && EVALUATOR_DETECT_RE.test(l)) {                       // Class 9 — special-casing the evaluator
      sawC9 = true;
      findings.push({ cls: 9, sev: 'warn', msg: `non-test source branches on the evaluator/test/CI: ${l.slice(1).trim().slice(0, 60)} — confirm behavior isn't different when audited` });
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
    if (l[0] === '+' && !l.startsWith('+++') && /\.sql$/i.test(cur)) sqlAdded += l.slice(1).replace(/--.*$/, '') + '\n';
  }

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
function auditRepo(cwd, git) {
  const files = git('ls-files').split('\n').filter(f => CODE_EXT_RE.test(f));
  const findings = [];
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
    // A CALL-forbidding rule (line_re targets a `\(` call, e.g. `\beval\s*\(`) matching inside a COMMENT is a
    // mention, not a use — so test such rules against the CODE portion only (a comment `// use of eval()` is
    // documentation). Non-call rules are left whole: some legitimately target comments (`@ts-ignore`, a slur).
    const callRule = /\\\(/.test(String(r.line_re || ''));
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
        // matchable view: call-rules see code only (comments stripped, state threaded in line order); others raw
        const view = callRule ? byFile[f].map(x => splitCodeComment(x, ext, st).code) : byFile[f];
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
  ].join('\n');
}

/**
 * Extract { intent, bashCmds, results } from a transcript JSONL string.
 * intent = first non-sidechain user text (harness noise stripped); bashCmds =
 * Bash tool_use commands; results = tool_result {is_error, text}.
 */
export function parseTranscript(jsonlText) {
  const entries = (jsonlText || '').split('\n')
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean)
    .filter(e => e.isSidechain !== true); // main session only — never a subagent's claims

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
  let bgLaunched = 0, bgDone = 0;                  // background tasks launched vs completed (async_done evidence)
  for (const e of entries) {
    const content = e.message?.content;
    // completion notices arrive as text ("<task-notification> … <status>completed")
    const asText = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(b => b?.type === 'text' ? (b.text || '') : '').join(' ') : '';
    if (/task-notification/i.test(asText) && /\b(completed|status>\s*completed|finished)\b/i.test(asText)) bgDone++;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.command) bashCmds.push(b.input.command);
      if (b?.type === 'tool_use' && (b.name === 'Workflow'
        || ((b.name === 'Bash' || b.name === 'Task' || b.name === 'Agent') && b.input?.run_in_background === true))) bgLaunched++;
      // no-git "Diff Ledger": reconstruct added lines from the agent's Edit/Write tool calls (the
      // HARNESS logged these — unfakeable, not the agent's self-report). Used when git is absent/empty.
      if (b?.type === 'tool_use' && b.input?.file_path && (b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit')) {
        const added = b.name === 'Write' ? String(b.input.content || '')
          : b.name === 'Edit' ? String(b.input.new_string || '')
          : (b.input.edits || []).map(x => String(x.new_string || '')).join('\n');
        if (added) toolDiffParts.push(`+++ b/${b.input.file_path}\n` + added.split('\n').map(l => '+' + l).join('\n'));
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
      if (b?.type === 'tool_result') results.push({ is_error: b.is_error === true, text: JSON.stringify(b.content || '') });
    }
  }
  return { intent, asks, commandsInvoked, commandInvocations, bashCmds, mcpCmds, results, bgPending: bgLaunched > bgDone, toolDiff: toolDiffParts.join('\n'), mcpSql: mcpSqlParts.join('\n') };
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

export function openLoops(asks = [], diff = '') {
  const changed = changedFiles(diff).join('\n') + '\n' + diff;
  const changedLower = changed.toLowerCase();
  const code = codeOnlyAdded(diff);
  const open = [];
  for (const a of asks) {
    const named = namedDeliverables(a);                       // HARD deliverables only (nag-worthy)
    if (!named.length) continue;                              // no gradeable HARD deliverable → don't nag
    if (!named.some(n => grounds(n, changed, changedLower, code))) // named something, but it's absent from the diff
      open.push({ ask: a.length > 90 ? a.slice(0, 90) + '…' : a, missing: named.slice(0, 3) });
  }
  return open;
}

// Things that look like a named token but CANNOT land in a git diff, so tracking them = guaranteed
// false positive (the failure that trains agents to game the deferral hatch). Three buckets:
//   • out-of-repo / temp paths — scratchpad work, /tmp artifacts, absolute paths outside the tree
//   • the tool's own files — .claude/groundtruth/*, tasks.json (the circular self-reference)
//   • convention docs read as REFERENCE — CLAUDE.md/README/SCHEMA/… are read targets, not deliverables,
//     UNLESS a write verb explicitly targets them ("update CLAUDE.md"). "read CLAUDE.md" must abstain.
const NONREPO_OR_TOOL = /(?:^\/|(?:^|\/)(?:tmp|temp|scratch|scratchpad)\/|\.claude\/groundtruth\/|^tasks\.json$|^(?:compiled|proposed)-rules\.json$)/i;
const CONVENTION_DOC = /^(?:CLAUDE|AGENTS|README|SCHEMA|ARCHITECTURE|CONTRIBUTING|LICENSE|CHANGELOG|ROADMAP|HANDOFF)\.md$/i;

// ── Request/non-request gate — kill the "conversational aside → open loop" false positive, deterministically ──
// The ledger used to mint a task from ANY deliverable-looking token, even when the sentence was an OBSERVATION,
// not a request ("I can see a 304 in `handleUpload`, it's fine, no fix needed"). That's the live FP: an aside
// tracked as an undelivered deliverable, nagged every turn. No LLM — this is just the ledger's own "when
// unsure, don't track" extended to the sentence's framing. A model in front of every stop would (a) void the
// "deterministic, offline, no-LLM" positioning and (b) let a model SILENTLY SUPPRESS a real open-loop (an
// invisible false-negative is worse than a visible over-nag), so the fix stays regex.
const NON_REQUEST_RE = new RegExp([
  // "X is fine / it's ok / that's expected / looks correct" — a bare copula counts, not just it's/that's,
  // so "the 304 is fine" reads as an observation (a real request keeps its action verb after the strip).
  "\\b(?:that'?s|it'?s|this is|which is|is|are|was|were|looks?|seems?|appears?)\\s+(?:fine|ok|okay|expected|intentional|correct|working|by design|working as intended)\\b",
  "\\bno\\s+(?:fix|change|action|need)\\b",
  "\\b(?:don'?t|do not|no need to)\\s+(?:worry|fix|touch|change|bother)\\b",
  "\\b(?:ignore|leave|disregard)\\s+(?:the|that|this|it)\\b",
  "\\bnot a (?:problem|bug|blocker)\\b|\\bexpected behaviou?r\\b",
  "\\bi(?:'?m| am)?\\s+(?:can\\s+)?(?:see|seeing|noticed?|getting)\\b",
  "\\b(?:looks?|seems?|appears?)\\s+(?:like|to be|fine|ok)\\b",
  "\\b(?:fyi|just noting|for (?:reference|context|the record))\\b",
].join("|"), "i");
// A positive request signal — an imperative aimed at the codebase.
const REQUEST_VERB_RE = /\b(?:add|create|implement|build|write|fix|change|update|edit|modif\w+|refactor|remove|delete|replace|wire|make|handle|support|migrate|rename|extract|revert|patch|correct|move|drop|split|port|convert|pull|hoist|rework|swap|introduce|append|generate|set\s+up|hook\s+up)\b/i;
// A turn read as a QUESTION (interrogative) — a distinct FP class from the dismissals above ("is report.js
// right?"), also answered in conversation with no diff.
const QUESTION_RE = /\?\s*$|^\s*(?:why|what|whats?|how|is|are|was|were|does|do|did|should|shall|can|could|would|will|which|when|where|who|whom|whose)\b/i;
// Trackable iff it is NOT (framed as observation/question with no surviving action verb). The verb test runs
// on the text with the dismissal phrases STRIPPED — critical, because "no fix needed" itself contains the
// verb "fix"; testing the raw string would let that negated "fix" mark the aside as a real request (the bug
// in the naive `NON_REQUEST && !REQUEST_VERB` form). "…is fine but fix the 500 in retry.js" keeps a real,
// un-stripped "fix" → still tracked. Exported for the self-check.
export function isTrackableRequest(text) {
  const s = String(text);
  const framed = NON_REQUEST_RE.test(s) || QUESTION_RE.test(s);
  if (!framed) return true;                                          // plain imperative → track
  const stripped = s.replace(new RegExp(NON_REQUEST_RE.source, 'gi'), ' ');   // drop "no fix"/"it's fine"/… so their inner verbs don't count
  return REQUEST_VERB_RE.test(stripped);                            // a real (non-negated) action verb survives → still a request
}

// Pure token extraction: a path/filename, a `backticked` token, or a camelCase symbol — MINUS the buckets
// above (out-of-repo, tool-state, read-only convention docs). No framing gate here — the gate/tier decision
// lives in classifyDeliverables so a questionable ask is DEMOTED (to soft), never silently dropped.
function extractTokens(text) {
  const t = String(text);
  const writesADoc = /\b(?:write|update|edit|modif\w+|append|add(?:ing)?\s+to|rewrite|create|regenerate|fix|change|replace|remove|delete|correct|revise|adjust|patch)\b/i.test(t);
  return (t.match(new RegExp('[\\w/-]+\\.(?:' + SRC_EXT + ')\\b|`[^`]+`|\\b[a-z]+[A-Z][a-zA-Z]+\\b', 'g')) || [])
    .map(s => s.replace(/`/g, '')).filter(s => s.length > 3)
    .filter(s => !NONREPO_OR_TOOL.test(s))                    // can't appear in a git diff → never a deliverable
    .filter(s => !(CONVENTION_DOC.test(s.split('/').pop()) && !writesADoc));  // a doc is a read target unless written
}

// Clause boundaries — so a token binds to the framing of ITS OWN clause, not the whole turn. "handleUpload is
// fine, but fix retry.js" must bind retry.js (its clause commands 'fix') apart from handleUpload (its clause
// is 'is fine'). Split on sentence enders + contrastive conjunctions.
function splitClauses(text) {
  // A `.` is a sentence boundary ONLY when followed by whitespace/end — NOT the dot inside `compiler.mjs`
  // or `3.14` (which a naive `[.;]` split would shred, destroying the filename token).
  return String(text).split(/\.(?=\s|$)|[;\n]+|\bbut\b|\bhowever\b|\bthough\b|\bwhereas\b|\byet\b/i).map(s => s.trim()).filter(Boolean);
}
// A token is a REFERENCE (discussion), not a COMMISSION, when its only occurrence in the ask is inside a
// PASTED artifact — a ``` fence, a `>`-quoted line, or a `file.js:line` stack-trace ref (paste-provenance,
// the real `redirectionChainSiteScript.js` case). Reference tokens DEMOTE to soft (demote-don't-drop).
// NOTE: token-novelty via prior AGENT text was REMOVED (Fable C2) — the agent's own reply is agent-influenceable
// and demoted the very ask it was answering; an audited agent must never be able to shape its own verdict.
// Paste-provenance stays because it's grounded in the USER's text, which the agent can't author.
function pasteStripped(askText) {
  return String(askText)
    .replace(/```[\s\S]*?```/g, ' ')                 // fenced code blocks
    .replace(/^\s*>.*$/gm, ' ')                       // quoted pasted lines
    .replace(/[\w./-]+\.\w+:\d+/g, ' ');              // stack-trace file:line refs
}

// Classify an ask's deliverable tokens into HARD (an imperative request naming a fresh deliverable — nag-once,
// can escalate to block) vs SOFT (named a deliverable but framed as observation/question, or a paste-reference
// — surfaced once, never blocks, auto-expires). Paste-provenance is computed on the FULL ask ONCE, before
// clause-splitting (splitClauses shreds a ``` fence into separate clauses, so a per-clause paste check was
// structurally blind — Fable M2). Per-clause framing then binds each token; a token HARD in any clause stays hard.
export function classifyDeliverables(text) {
  const full = String(text);
  const paste = pasteStripped(full);
  const isRef = (tok) => { const b = tok.replace(/`/g, ''); return full.includes(b) && !paste.includes(b); };
  const hard = new Set(), soft = new Set();
  for (const clause of splitClauses(full)) {
    const req = isTrackableRequest(clause);
    for (const tok of extractTokens(clause))
      (req && !isRef(tok) ? hard : soft).add(tok);
  }
  for (const t of hard) soft.delete(t);                                        // hard wins over soft
  return { hard: [...hard], soft: [...soft] };
}
// Back-compat shim: the HARD deliverables of an ask (the nag-worthy ones). Used by openLoops.
function namedDeliverables(text) { return classifyDeliverables(text).hard; }

/**
 * Task ledger — the PERSISTENT contract memory, one task per user ask that names a deliverable. A task
 * is marked DONE only when its deliverable GROUNDS in the cumulative diff — NEVER by the agent's
 * acknowledgment, so "I'll do it" / "acknowledged" can't close it; only delivery (or a human setting
 * status:'deferred') can. That is the whole answer to "the agent acknowledges and moves on". Asks that
 * name no deliverable aren't tracked (abstain over false-nag). Pure + idempotent; preserves human-set
 * 'deferred'/'done'. The drive (block while pending) is applied by main(), not here.
 */
export function updateTaskLedger(prior = [], asks = [], diff = '') {
  const changed = changedFiles(diff).join('\n') + '\n' + diff;
  const changedLower = changed.toLowerCase();
  const code = codeOnlyAdded(diff);
  const byKey = new Map(prior.map(t => [t.task, t]));
  for (const a of asks) {
    const { hard, soft } = classifyDeliverables(a);
    // A task's deliverable = the tokens OF ITS OWN TIER. A HARD task must NOT be closed by a soft/reference
    // token that happens to ground ("`handleUpload` is fine, but fix retry.js" → retry.js is the deliverable;
    // handleUpload landing must not green it — Fable H1). A soft task closes on its own soft tokens.
    const deliverable = hard.length ? hard : soft;
    if (!deliverable.length) continue;                        // no gradeable deliverable at all → not tracked
    const tier = hard.length ? 'hard' : 'soft';               // hard = imperative request; soft = aside/reference
    const task = a.length > 100 ? a.slice(0, 100) + '…' : a;
    let t = byKey.get(task);
    if (!t) { t = { id: taskId(task), task, deliverable, tier, status: 'pending' }; byKey.set(task, t); }
    if (!t.id) t.id = taskId(t.task);                          // backfill id on tasks from older ledgers
    if (t.tier == null) t.tier = tier;                        // backfill tier on older ledgers
    // Recompute status from the diff EVERY turn — NEVER trust a persisted 'done'. An agent can forge
    // status:"done" straight into tasks.json (out of band, invisible to the tamper diff-scan), so 'done'
    // must be re-derived: a task is done iff its deliverable still grounds (in CODE for a symbol — a comment
    // mention doesn't close it) in the cumulative diff. 'deferred' is human-confirmed (applyConfirmedDeferrals).
    if (t.status !== 'deferred') t.status = deliverable.some(n => grounds(n, changed, changedLower, code)) ? 'done' : 'pending';
  }
  return [...byKey.values()];
}

// Stable short id for a task (deterministic over its text) so a human can name it unambiguously.
export const taskId = (s) => { let h = 0; for (const c of String(s)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return 't' + (h >>> 0).toString(36).slice(0, 4); };

// The Phase-6 surfacing decision, PURE (main maps every task through it, then persists the returned task).
// Fable's cost model: a wrong mint must be cheap, so a loop surfaces ONCE at mint then goes quiet — it
// resurfaces only when the agent CLAIMS it done (the moment to re-check). Per-token done-match: a task
// escalates to BLOCK only if the completion claim references THAT task's own deliverable token — a generic
// "all done!" no longer flips every unrelated pending task to block. Tiers: hard → warn (block on matching
// claim), quiet after; soft → a one-time info "aside" (never injected/blocking), auto-expires after softExpire
// turns. Returns { task: next-state, finding: {…}|null }. Exported for the self-check.
// A completion claim about THIS token counts only if the clause naming the token is not itself negated /
// deferred ("upload.js still pending — will do next" is an HONEST disclosure, not a false "done" — Fable M3).
// Strong deferral/negation signals only. `remaining`/`left` are deliberately EXCLUDED: they invert
// ("nothing remaining", "items left: none") and became a dodge that demoted a real false-done to warn; a
// genuine "X still remaining" is already caught by `still`. Biasing toward BLOCK on the backstop is correct
// (a missed false-done is worse than a rare false-block — Fable's severity call).
const CLAIM_NEG_RE = /\b(?:still|pending|not|todo|will|next|blocked|unfinished|incomplete|wip|isn'?t|won'?t|haven'?t|instead|yet)\b/i;
function claimClosesToken(claimMsg, tok) {
  const bare = String(tok).replace(/`/g, '');
  if (!COMPLETION_RE.test(claimMsg) || !claimMsg.includes(bare)) return false;
  // Decide on PROXIMITY to the token, not the whole clause (Fable pass-2, defect A+B): a whole-clause test
  // both let a far-away "pending/will" (about OTHER work) dodge a real false-done, AND — reusing the
  // ask-oriented splitClauses, which splits on `yet` — shredded "not yet done" into a false block. Test a
  // tight word window around EACH occurrence: the token closes only when NONE describes it as deferred/negated.
  // NOTE: fixed ±3-word window is the tuning knob — widen only if a real negation lands just outside it
  //           (too wide re-admits the "nothing pending" dodge from 4 words away).
  const words = String(claimMsg).split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (!words[i].includes(bare)) continue;
    if (!CLAIM_NEG_RE.test(words.slice(Math.max(0, i - 3), i + 4).join(' '))) return true;  // unqualified done here
  }
  return false;
}
export function surfaceOpenLoop(t, claimMsg = '', softExpire = 3) {
  if (t.status !== 'pending')                                     // done → reset so a re-open nags again
    return { task: t.status === 'done' ? { ...t, surfaced: false, age: 0 } : t, finding: null };
  const age = (t.age || 0) + 1;
  const claimed = (t.deliverable || []).some(tok => claimClosesToken(claimMsg, tok));   // per-token done-match, negation-aware
  const missing = (t.deliverable || []).slice(0, 2).join(' / ');
  if (t.tier === 'soft') {
    // soft aside: surface ONCE as a quiet info note, then stay silent, and auto-expire — never blocks, never
    // re-nags. It's low-stakes by construction, so quiet == fine here (it does not misreport completion).
    if (age > softExpire) return { task: { ...t, age, status: 'stale' }, finding: null };
    if (t.surfaced) return { task: { ...t, age }, finding: null };
    return { task: { ...t, age, surfaced: true }, finding: { cls: 'openloop', sev: 'info',
      msg: `unconfirmed aside [${t.id}] — "${t.task}" (named ${missing} but framed as an observation/question, not a request — set aside; restate as an instruction to track, or reply \`defer ${t.id}\`)` } };
  }
  // HARD task: ALWAYS emit a finding so the card + verdict honestly reflect the still-pending task (quiet != green
  // — Fable H2). nag-once controls only INJECTION: after the first surface, the finding is marked `quiet` so
  // main won't re-inject it into the agent's context, but the user still sees "N pending". A matching done-claim
  // escalates to block (and re-injects); otherwise warn.
  const quiet = !!t.surfaced && !claimed;
  return { task: { ...t, age, surfaced: true }, finding: { cls: 'openloop', sev: claimed ? 'block' : 'warn', quiet,
    msg: `pending task [${t.id}] — "${t.task}"${t.deferRequested
      ? ` (agent tried to defer this — only you can, by replying \`defer ${t.id}\`)`
      : claimed ? ` — you claimed it done, but ${missing} is not in the diff`
      : ` (no ${missing} in the diff yet — or reply \`defer ${t.id}\` to set aside)`}` } };
}

// Anti-gaming, the ACTUAL lever removal. The previous version trusted a file (confirmed-deferrals.json),
// but a file is agent-writable — the agent can forge its own confirmation, so that's no confirmation at
// all. The ONLY input an agent cannot forge is the user's typed words: it cannot author a real user turn
// (parseTranscript's structural filter guarantees this). So a deferral is honored only when the USER
// typed `defer <id>` (the id is shown in the card). Read those ids from the real asks; everything else
// stays pending. Writing 'deferred' anywhere — tasks.json OR a confirmations file — now buys nothing.
export function humanDeferrals(asks = []) {
  const ids = new Set();
  for (const a of asks)
    for (const m of String(a).matchAll(/\b(?:\/?groundtruth-defer|defer)\s+(t[0-9a-z]{2,6})\b/gi)) ids.add(m[1].toLowerCase());
  return ids;
}

export function applyConfirmedDeferrals(tasks = [], confirmedIds = new Set()) {
  return tasks.map(t => (t.status === 'deferred' && !confirmedIds.has(t.id || taskId(t.task)))
    ? { ...t, status: 'pending', deferRequested: true } : t);
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
function snapshotTargets(session) {
  return [
    { rel: '.claude/groundtruth/config.json', ratifiedBy: 'groundtruth-block' },
    { rel: '.claude/groundtruth/compiled-rules.json', ratifiedBy: ['groundtruth-rules', 'groundtruth-setup'] },
    { rel: `.claude/groundtruth/${session}.baseline.json`, ratifiedBy: null },
  ];
}
const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
function snapHashes(cwd, session) {
  const m = {};
  for (const { rel } of snapshotTargets(session)) { try { m[rel] = sha16(readFileSync(join(cwd, rel), 'utf8')); } catch { m[rel] = null; } }
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

  const isHonesty = f => [1, 2, 3, 4, 6, 9, 'async_done'].includes(f.cls);   // false-claim / stub / no-op / phantom / dangling-ref / special-casing / false-completion
  const sortF = a => [...a].sort((x, y) => (x.sev === 'block' ? 0 : 1) - (y.sev === 'block' ? 0 : 1));
  const sub = f => `       ${SEV[f.sev]} ${CLASS_NAME[f.cls] || f.cls}${f.rule ? ` [${f.rule}]` : ''} — ${f.msg}`;
  const hon = findings.filter(isHonesty);
  const loops = findings.filter(f => f.cls === 'openloop');                  // contract memory: asked, not delivered
  const deferred = findings.filter(f => f.cls === 'deferred');              // self-deferred: surfaced, never silent
  const tamper = findings.filter(f => f.cls === 'tamper');                  // agent rewrote the referee's own state
  const rule = findings.filter(f => !isHonesty(f) && !['openloop', 'deferred', 'tamper'].includes(f.cls));  // security B/C + compiled rules R

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
    loops.length
      ? `  ${loops.some(f => f.sev === 'block') ? '🔴' : '🟡'} Tasks — ${loops.length} pending (one per ask that named a deliverable; "done" only when it lands in the diff, never on the agent's say-so):`
      : deferred.length
      ? `  🟡 Tasks — 0 pending; ${deferred.length} human-confirmed deferral(s) below (set aside with sign-off, surfaced for transparency):`
      : `  🟢 Tasks — every ask that named a deliverable is delivered`,
    ...loops.map(f => `       ${f.sev === 'block' ? '🔴' : '🟡'} ${f.msg}`),
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
  openloop: 'You claimed done, but this task is still pending. DELIVER the file/symbol it named — acknowledging it does NOT close it, and you cannot defer it yourself (an agent-written "deferred", in any file, is re-opened). Only the USER can set it aside, by typing `defer <id>`; do not type that for them.',
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
const UNTRACKED_SCAN_CAP = 1_000_000;   // scan the first 1 MB of each untracked file — bounds COST, not COVERAGE
function untrackedAdded(cwd, skip = new Set()) {
  let content = ''; const oversized = [];
  try {
    const porcelain = execSync('git status --porcelain=v1 --untracked-files=all', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const ln of porcelain.split('\n').filter(Boolean)) {
      if (!ln.startsWith('??')) continue;                               // untracked only — tracked edits are in git diff
      const f = ln.slice(3).trim().replace(/^"(.*)"$/, '$1');
      if (skip.has(f) || /(^|\/)\.claude\/groundtruth\//.test(f)) continue;
      let buf; try { buf = readFileSync(join(cwd, f)); } catch { continue; }
      // H5/H6: do NOT skip a file by extension OR by a binariness heuristic — both were one-token
      // bypasses (rename to .lock; prepend one NUL). Secrets are PRINTABLE, so EXTRACT the printable runs
      // (non-printable bytes → line breaks) and scan those. A real binary just yields short runs the
      // specific secret patterns won't match; a text file with an injected NUL is fully scanned.
      // H2: NEVER drop a file by size — scan the first 1 MB; if larger, surface it loudly (oversized).
      const printable = buf.subarray(0, UNTRACKED_SCAN_CAP).toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, '\n');
      if (printable.trim()) content += `\n+++ b/${f}\n` + printable.split('\n').map((l) => '+' + l).join('\n');
      if (buf.length > UNTRACKED_SCAN_CAP) oversized.push(`${f} (${buf.length} bytes)`);
    }
  } catch { /* no git → skip */ }
  return { content, oversized };
}

// ── main: only when run directly, not when imported by the test ──
// Surface the PRIOR turn's findings into the NEXT turn's context (via the UserPromptSubmit --intent hook),
// so the agent — not just a .md nobody opens in VS Code — actually sees them and can triage. Passive FYI:
// injecting the full card here once made the model reply UNPROMPTED (see the Stop path), so it says
// explicitly "don't reply, triage only". Empty in → '' (a clean turn injects nothing). Pure + tested.
export function priorFindingsContext(findings = []) {
  const f = (findings || []).filter(x => x && (x.sev === 'warn' || x.sev === 'block'));
  if (!f.length) return '';
  const lines = f.map(x => `  • [${x.sev}] ${CLASS_NAME[x.cls] || x.cls} — ${x.msg}`).join('\n');
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
    const diff = git('diff --cached', cwd);
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
    const diff = git(`diff ${dr.range}`, cwd);
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

  // Baseline diffing: diff against the session's START ref (captured at SessionStart) so committed
  // work is still seen; fall back to HEAD when no baseline was captured.
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(join(cwd, '.claude', 'groundtruth', `${payload.session_id}.baseline.json`), 'utf8'));
  } catch { /* no baseline */ }
  const baseRef = baseline?.startRef || 'HEAD';
  let diff = git(`diff ${baseRef}`, cwd);

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
  const scanDiff = dropExcludedFiles(diff + ut.content
    + (parsed.mcpSql ? `\n+++ b/<mcp-sql>\n` + parsed.mcpSql.split('\n').map((l) => '+' + l).join('\n') : ''));

  const findings = analyze({
    claim: payload.last_assistant_message || '',
    diff: scanDiff, bashCmds: parsed.bashCmds, results: parsed.results, cwd, bgPending: parsed.bgPending,
  });

  // H2: an untracked file too large to fully scan is surfaced, never silently dropped (a secret padded
  // past the cap can't buy a green — "can't fully see it" reads amber, not benign). No `rule` field: that
  // key is reserved for genuine compiled-rule ids (the card prints [id] + a `/groundtruth-rules unarm <id>`
  // hint from it), and this built-in coverage-gap isn't unarmable via that command.
  for (const f of ut.oversized) findings.push({ cls: 'R', sev: 'warn',
    msg: `untracked file too large to fully scan for secrets — ${f}; scanned first ${UNTRACKED_SCAN_CAP / 1e6} MB only, review the remainder` });

  // §10: also evaluate the deterministic rules compiled from this repo's own docs (CLAUDE.md/skills).
  findings.push(...runCompiledRules(scanDiff, loadCompiledRules(cwd)));

  // Class 6 — a dropped symbol left dangling under a preservation claim (symbol-integrity.mjs). Claim-gated
  // here (the Stop-hook honesty run); the pre-commit path runs it gate-free. `scanDiff` (not `diff`) so a
  // Bash-moved def is seen; grep searcher is the shared `mkGrepTree` (exit-1→'' vs throw→fail-open).
  findings.push(...checkDroppedSymbols({ claim: payload.last_assistant_message || '', diff: scanDiff, asks: parsed.asks || [], grepTree: mkGrepTree(cwd) }));

  // §11: tamper-evidence — did THIS turn rewrite the referee's own ground truth (rules/config/ledger)?
  // Severity anchors to ENV block authority, never to config.json (which the agent may have just
  // rewritten); a write ratified by the matching slash-command is legitimate. See refereeTamper.
  const envBlock = process.env.GROUNDTRUTH_BLOCK === '1';
  findings.push(...refereeTamper(diff, parsed.commandsInvoked || new Set(), envBlock));
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

  // Task ledger — the PERSISTENT contract memory (one ledger per session). Accumulates a task per user
  // ask that names a deliverable, marks it DONE only when the deliverable GROUNDS in the diff (never by
  // the agent's say-so — an acknowledgment can't close it), and DRIVES the pending ones: if the agent
  // CLAIMS completion while tasks are still pending, those flip to BLOCK so the remediation loop
  // re-presents them (retry cap → escalate, so a crude false-pending can't wedge); otherwise warn,
  // persistently visible. Answers "agent acknowledged and moved on" + "user wouldn't know what's done".
  const taskFile = join(cwd, '.claude', 'groundtruth', `${payload.session_id || 'session'}.tasks.json`);
  let priorTasks = []; try { priorTasks = JSON.parse(readFileSync(taskFile, 'utf8')); } catch {}
  // Honor only deferrals the USER typed (`defer <id>` in a real turn) — an agent-written 'deferred',
  // in tasks.json or anywhere, is re-opened to pending. The lever an agent could forge is gone.
  const ledger = applyConfirmedDeferrals(updateTaskLedger(priorTasks, parsed.asks || [], diff), humanDeferrals(parsed.asks || []));
  // Open-loop surfacing (Phase 6): nag-once + per-token done-match + tiers, via the pure surfaceOpenLoop.
  const surfaced = ledger.map(t => surfaceOpenLoop(t, payload.last_assistant_message || ''));
  const tasks = surfaced.map(s => s.task);                    // next-state to persist (surfaced/age/stale)
  for (const s of surfaced) if (s.finding) findings.push(s.finding);
  try { writeFileSync(taskFile, JSON.stringify(tasks, null, 2) + '\n'); } catch {}
  // What remains 'deferred' here is human-confirmed (the agent can't reach this state), so it's a
  // legitimate set-aside — surfaced for transparency at warn, never silent, never blocking.
  for (const t of tasks.filter(x => x.status === 'deferred'))
    findings.push({ cls: 'deferred', sev: 'warn',
      msg: `deferred (human-confirmed) — "${t.task}"${t.note ? ` — "${String(t.note).slice(0, 70)}"` : ''}` });

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

  try {
    const dir = join(cwd, '.claude', 'groundtruth');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${payload.session_id || 'session'}.md`), card + '\n');
    // persist surfaceable findings so the next UserPromptSubmit (--intent) injects them into the agent's
    // context — the .md alone is read by no one in VS Code (the silent-warn gap). Overwritten every turn.
    // Inject only NON-quiet warn/block findings: nag-once means a hard task already surfaced in a prior turn
    // still shows on the card (f.quiet stays in `findings`) but is NOT re-injected into the agent's context.
    const surf = projectFindings(findings);
    writeFileSync(join(dir, `${payload.session_id || 'session'}.findings.json`), JSON.stringify(surf));
    // cumulative history — one line per turn, never overwritten (weekly harvest)
    try {
      const rec = { ts: new Date().toISOString(), session: payload.session_id || 'session',
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
