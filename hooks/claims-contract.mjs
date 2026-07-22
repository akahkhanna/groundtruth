#!/usr/bin/env node
/**
 * claims-contract.mjs — Groundtruth v2, the CLAIMS CONTRACT (parser + schema validator).
 *
 * v1 reads the agent's English essay and GUESSES what was promised, then checks the guess against the
 * diff. Guessing from free prose is the unbounded problem — you cannot enumerate a natural language with
 * patterns, so every phrasing fix moves the failure to the next phrasing. v2 removes English from the
 * audited path: the agent ends every turn with ONE fenced, machine-readable block declaring exactly what
 * it did, and Groundtruth validates a grammar IT wrote instead of parsing a language it can't bound.
 *
 * This module is Week-1 scope ONLY — the front half of the pipeline:
 *   locate the fenced block  ·  JSON.parse it  ·  validate it against a fixed schema.
 * It is a PURE module: no fs, no git, no transcript, no network. `analyze(message)` in, verdict object
 * out — so it is fully testable without the Stop hook. The two VERIFY passes (claim↔diff and diff↔claims,
 * finding classes CA / UC) and the hook wiring are Week 2 / Week 3 and live elsewhere; nothing here reads
 * the diff. A block that is missing or malformed or schema-invalid is finding class `NC` (no contract).
 *
 * The grammar (JSON, not YAML — no indentation ambiguity, and `JSON.parse` is the whole tokenizer):
 *
 *   ```groundtruth-claims
 *   { "v": 1, "task": "…", "status": "complete|partial|blocked",
 *     "claims": [ { "t": "created", "file": "src/x.mjs", "symbols": ["foo"] }, … ] }
 *   ```
 *
 * Closed claim set (resist growing it): created · modified · deleted · renamed · tests_pass · build_pass
 * · deferred · no_change. `status` of `partial` or `blocked` REQUIRES at least one `deferred` claim — a
 * structural rule decidable from the block alone, so it is enforced here, not at verify time.
 */

export const CONTRACT_VERSION = 1;
export const FENCE_TAG = 'groundtruth-claims';
export const STATUSES = ['complete', 'partial', 'blocked'];

// Per-type required / optional fields. `req` must be present and valid; `optArr` (if present) must be a
// string array when given. `path` fields go through isValidPath; `str` fields must be non-empty strings.
export const CLAIM_TYPES = {
  created:    { req: { file: 'path' }, optArr: ['symbols'] },
  modified:   { req: { file: 'path' }, optArr: ['symbols'] },
  deleted:    { req: { file: 'path' } },
  renamed:    { req: { from: 'path', to: 'path' } },
  tests_pass: { req: { cmd: 'str' } },
  build_pass: { req: { cmd: 'str' } },
  deferred:   { req: { what: 'str', why: 'str' } },
  no_change:  { req: {} },
};

// The handback shown to the agent on an NC finding (Week-3 block loop). Kept here so the schema and the
// help that teaches it can never drift apart.
export const SCHEMA_HELP = [
  'End the turn with exactly one fenced block:',
  '',
  '```' + FENCE_TAG,
  '{',
  '  "v": 1,',
  '  "task": "<one line: what this turn was asked to do>",',
  '  "status": "complete | partial | blocked",',
  '  "claims": [',
  '    { "t": "created",  "file": "src/x.mjs", "symbols": ["foo"] },',
  '    { "t": "modified", "file": "src/y.mjs" },',
  '    { "t": "tests_pass", "cmd": "npm test" },',
  '    { "t": "deferred", "what": "<work not done>", "why": "<reason>" }',
  '  ]',
  '}',
  '```',
  '',
  'Claim types: created, modified, deleted, renamed, tests_pass, build_pass, deferred, no_change.',
  'status "partial" or "blocked" requires at least one "deferred" claim.',
].join('\n');

// Opening fence (3+ backticks + the tag on its own line) … content … closing fence line. `m` so ^/$ bind
// to line boundaries; non-greedy so nested content stops at the first closing fence. All matches are
// collected and the LAST wins — the end-of-turn block is the authoritative one.
const FENCE_RE = /(?:^|\n)`{3,}[ \t]*groundtruth-claims[ \t]*\r?\n([\s\S]*?)\r?\n`{3,}[ \t]*(?=\n|$)/g;

/** A repo-relative path shape: a non-empty string, no NUL, no newline, not absolute. Real resolution
 *  against the diff is a verify-stage concern; this only rejects shapes that can never be a diff path. */
export function isValidPath(v) {
  return typeof v === 'string'
    && v.trim().length > 0
    && !v.includes('\0')
    && !/[\r\n]/.test(v)
    && !v.startsWith('/');
}

function isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Find the claims block(s) in a message. Returns { raw, count } — raw is the inner text of the LAST
 * fenced block (null if none), count is how many were found (for tests / diagnostics).
 */
export function findClaimsBlock(message) {
  const { raws, count } = findClaimsBlocks(message);
  return { raw: raws.length ? raws[raws.length - 1] : null, count };
}

/** All fenced claims blocks, in document order. Returns { raws:[innerText…], count }. */
export function findClaimsBlocks(message) {
  if (typeof message !== 'string' || message.length === 0) return { raws: [], count: 0 };
  FENCE_RE.lastIndex = 0;
  const raws = []; let m;
  while ((m = FENCE_RE.exec(message)) !== null) raws.push(m[1]);
  return { raws, count: raws.length };
}

/**
 * Validate a parsed object against the contract schema. Returns { ok, errors, contract } — contract is
 * the input echoed back when ok (no mutation). Errors are specific, human-readable, and NC-handback-ready.
 */
export function validateContract(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['contract must be a JSON object'], contract: null };
  }

  if (obj.v !== CONTRACT_VERSION) errors.push(`"v" must be ${CONTRACT_VERSION}`);
  if (!isNonEmptyStr(obj.task)) errors.push('"task" must be a non-empty string');
  if (!STATUSES.includes(obj.status)) errors.push(`"status" must be one of ${STATUSES.join(' | ')}`);
  if (!Array.isArray(obj.claims)) {
    errors.push('"claims" must be an array');
    return { ok: false, errors, contract: null };   // can't validate entries without an array
  }

  obj.claims.forEach((c, i) => {
    const at = `claims[${i}]`;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at} must be an object`); return; }
    const spec = CLAIM_TYPES[c.t];
    if (!spec) {
      errors.push(`${at}.t "${c.t}" is not a known claim type (${Object.keys(CLAIM_TYPES).join(', ')})`);
      return;
    }
    for (const [field, kind] of Object.entries(spec.req)) {
      if (kind === 'path' && !isValidPath(c[field])) errors.push(`${at}.${field} must be a repo-relative path`);
      if (kind === 'str' && !isNonEmptyStr(c[field])) errors.push(`${at}.${field} must be a non-empty string`);
    }
    for (const field of spec.optArr || []) {
      if (c[field] === undefined) continue;
      if (!Array.isArray(c[field]) || !c[field].every(isNonEmptyStr)) {
        errors.push(`${at}.${field} must be an array of non-empty strings`);
      }
    }
  });

  // Cross-field: a non-complete status must name what is outstanding.
  if ((obj.status === 'partial' || obj.status === 'blocked')
      && !obj.claims.some(c => c && c.t === 'deferred')) {
    errors.push(`status "${obj.status}" requires at least one "deferred" claim`);
  }

  return { ok: errors.length === 0, errors, contract: errors.length === 0 ? obj : null };
}

/**
 * Locate + JSON.parse the block (no schema check). Returns { ok, value, error }. Separated from
 * validation so a test can distinguish "malformed JSON" from "well-formed but schema-invalid".
 */
export function parseContract(message) {
  const { raw, count } = findClaimsBlock(message);
  if (raw === null) return { ok: false, value: null, error: 'no groundtruth-claims block found', count };
  try {
    return { ok: true, value: JSON.parse(raw), error: null, count };
  } catch (e) {
    return { ok: false, value: null, error: `malformed JSON in claims block: ${e.message}`, count };
  }
}

/**
 * The Week-1 entry point. Given an assistant message string, return a verdict:
 *   { ok, code, reason, contract, errors, count }
 *     ok       — true iff a single well-formed, schema-valid contract was found
 *     code      — null when ok; 'NC' (no contract) otherwise
 *     reason    — null when ok; an NC-handback string (specific cause + SCHEMA_HELP) otherwise
 *     contract  — the validated {v,task,status,claims} object when ok; null otherwise
 *     errors    — the specific validation/parse errors (empty when ok)
 *     count     — number of fenced blocks seen (last wins)
 * Verification of the claims against the real diff/transcript is Week 2 and is NOT done here.
 */
export function analyze(message) {
  const nc = (errors, count = 0) => ({
    ok: false, code: 'NC', contract: null, errors,
    reason: `${errors.join('; ')}\n\n${SCHEMA_HELP}`, count,
  });

  const { raws, count } = findClaimsBlocks(message);
  if (count === 0) return nc(['no groundtruth-claims block found'], 0);
  // Prefer the LAST block that PARSES and VALIDATES. A real contract followed by a quoted SCHEMA_HELP example,
  // an echoed NC handback, or a block being discussed in docs must not be superseded into NC by that trailing
  // invalid block — NC fires only when NO block validates. Residual: a second, fully-VALID example block that
  // comes last still wins (inherent ambiguity), but an honest turn's real block is normally last. (Fable FP-9.)
  let lastErr = ['no groundtruth-claims block found'];
  for (let i = raws.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(raws[i]); }
    catch (e) { if (i === raws.length - 1) lastErr = [`malformed JSON in claims block: ${e.message}`]; continue; }
    const v = validateContract(obj);
    if (v.ok) return { ok: true, code: null, reason: null, contract: v.contract, errors: [], count };
    if (i === raws.length - 1) lastErr = v.errors;
  }
  return nc(lastErr, count);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────
 * WEEK 2 — the VERIFY passes. Two directions form the pincer that closes the extraction-error loop:
 *   CA (claimed-but-absent) — a claim the diff/transcript don't support. Omission-proof against invention.
 *   UC (undeclared-change)  — a changed file no claim covers. The capability v1 never had: it audits the
 *                             WHOLE diff by construction, not just what it managed to extract from prose.
 *
 * This stays PURE: no fs, no git, no transcript parsing. It takes a normalized `reality` the Stop hook
 * (Week 3) will assemble from the engine's own `git diff --name-status`, `collectDefs`, and bash evidence:
 *
 *   reality = {
 *     files:  [ { status: 'A'|'M'|'D'|'R', path, from? } ],  // A/M/D: path is the file. R: from→path (to).
 *     commands:     [ { cmd, ok } ] | undefined,             // ran commands + green/red. undefined ⇒ ABSTAIN
 *                                                            //   on tests_pass/build_pass (no transcript).
 *     symbolsByFile: { [path]: string[] } | undefined,       // symbols ADDED per file. undefined ⇒ ABSTAIN
 *                                                            //   on symbol claims. A file absent from the
 *                                                            //   map (couldn't be lexed) also abstains.
 *     excluded: (path) => boolean,                           // dropExcludedFiles predicate. default: none.
 *   }
 *
 * Abstain-over-guess is deliberate and matches the house rule (a false positive is fatal): every check
 * that can't be decided from the reality it was given emits NOTHING rather than a wrong finding.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

// CA is a false claim (the core sin) → block. UC is an undeclared change that may be incidental → warn.
// Severities are the defaults; Week-3 config/enforcement decides what actually halts a stop.
const SEV_CA = 'block';
const SEV_UC = 'warn';
const SEV_SOFT = 'warn';   // a claim that IS supported but mislabeled (right file, wrong verb) — softer.

// Normalize a path for comparison: trim, backslashes → '/', drop a leading './'. Without this, an honest
// claim written `./src/x.mjs` or (Windows) `src\x.mjs` never matches the git-relative diff path → CA block. (Fable finding 8.)
const norm = (p) => String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');

// A command that merely MENTIONS a test cmd in a string/echo/grep is not a run of it — blessing `echo "npm
// test would pass"` (exit 0) as evidence for `tests_pass:{cmd:"npm test"}` is a false green. (Fable finding 5.)
// A command whose LEADING word only PRINTS/SEARCHES its arg (never runs it). Three clauses: word-shaped names
// carry a `\b`; `#` matches UNCONDITIONALLY (a shell comment runs to end-of-line regardless of the next char —
// `# npm test` AND `#npm test` are both no-ops, Fable review D3); `:` (the no-op builtin) needs a space/end
// after it, since `:foo` would be a distinct command name. The old `|:|…|#)\b` was DEAD (a `#`/`:`→space gap
// is not a word boundary), so these mentions laundered a never-run claim into a pass. (Fable adv FN-3 + D3.)
const LOOKALIKE_RE = /^\s*(?:echo|printf|cat|grep|rg|ag|ls|head|tail|sed|awk|true|false)\b|^\s*#|^\s*:(?:\s|$)/;
// Interpreters that EXECUTE a quoted string as a command — ONLY these turn a QUOTED occurrence of `want` into
// a real run. `bash -c "npm test"` runs the tests; `git grep "npm test"`, `git log --grep "npm test"`,
// `find -name "npm test"`, `: "npm test"` merely MENTION the string — they must neither bless nor condemn the
// claim. The old segment path tested the raw (un-masked) text, so any quoted mention counted as a run → an
// honest `git grep "npm test"` (exit 1) forced a block-tier CA. (Fable adversarial FP-1 / FN-1.)
const INTERP_RE = /(?:^|[\s;&|])(?:ba|z|da|a|k|c|tc)?sh\b[^"'\n]*?\s-[a-z]*c\b/i;

// Does a tests_pass/build_pass claim's cmd correspond to a command that actually ran? Quoted substrings are
// masked to SAME-LENGTH spaces ONLY to locate the unquoted `&& || ; |` split points (so an operator inside a
// quoted arg doesn't split); the segments are then tested against their ORIGINAL text — so a real invocation
// INSIDE quotes (`bash -c "npm test"`, `pytest -k "not slow"`) is NOT erased and still matches, while a mere
// mention in a lookalike (`grep "lint && npm test" f`, `echo "npm test"`) is excluded by the lookalike prefix.
// (Fable re-review: mask-for-splitting only, never mask the matched text — masking a real run was a false CA block.)
const SPLIT_OP = /&&|\|\|?|;/g;

// ── Stage-3 sensors: ported VERBATIM from the retired v1 class-1 so there is no precision loss (defined here,
// not imported, to avoid a cycle — the engine imports this module). They refine a GREEN tests_pass run. ──
const TEST_BUILD_RE = /\b(npm (?:test|run (?:build|lint|typecheck))|yarn (?:test|build|lint)|pnpm (?:test|build|lint)|bun (?:test|run)|deno (?:test|task|check)|node --check|node\s+[^|;&]*\.test\.|vitest|jest|mocha|ava|playwright|cypress|tsc|pytest|tox|nox|unittest|go (?:test|build|vet)|cargo (?:test|build|check|clippy)|(?:bundle exec )?rspec|rails test|rake test|minitest|(?:\.\/)?(?:mvnw?|gradlew?)\b[^|;&]*\b(?:test|verify|build|check)|phpunit|pest|dotnet (?:test|build)|ctest|cmake --build|make(?:\s+[\w.-]+)?|swift test|bats|mix test|lein test|clojure -M:test)\b/;
const WEAK_CHECK_RE = /^\s*(?:\w+=\S+\s+)*(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn)\s+)?(?:\S*\/)?(?:node --check|node\s+-e\b|tsc(?=\s|$)|deno check|cargo check|go vet|py_compile|ruby -c\b)/;
const SHELL_SEG_RE = /&&|\|\|?|;|\n/;
// TWO regexes, on purpose. The WORDED alternatives are all count-anchored ("3 failing", "Tests: 1 failed",
// node:test "# fail 1" with N≥1 — never "# fail 0"), so /i is safe: a benign lowercase "fail" can't satisfy
// them without a leading non-zero count. The bare runner BANNER (jest "FAIL src/x", pytest "FAILED …",
// go "--- FAIL", "FAIL\tpkg") is case-SENSITIVE and split out: the old `(?:^|\s)FAIL\b` under /i was doubly
// wrong — it FIRED on lowercase prose ("should not fail", a file/dir literally named `fail`, "# fail 0" on a
// PASSING node:test run) and MISSED pytest's real `FAILED` banner (\b after FAIL rejects the trailing ED).
// A false "your green output reports failures" on an honest run is exactly the FP this warn tier must not emit.
const TEST_FAIL_RE = /\b[1-9]\d*\s+(?:failing|failed|failures?)\b|\b[1-9]\d*\s+tests?\s+(?:failed|failing)\b|\bAssertionError\b|\bnot ok \d|Tests?:\s*[1-9]\d*\s+(?:failed|failing)|#\s*fail\s+[1-9]|---\s*FAIL:|test result:\s*FAILED|\b\d+\s+examples?,\s*[1-9]\d*\s+failures?|Tests run:\s*\d+,\s*Failures:\s*[1-9]|\bpanicked\b/i;
// case-sensitive AND line-anchored: real runner banners (jest `FAIL src/x`, pytest `FAILED …`, go `FAIL\tpkg`)
// sit at the START of a line. A mid-line `FAILED` is prose/log noise, not a verdict — a passing test TITLED
// "FAILED to connect (now fixed)" or an app log "request FAILED (expected)" echoed in green output must NOT
// fire. Requires the decoded (real-newline) run text from parseTranscript. (Fable adversarial FP-7.)
const TEST_FAIL_BANNER_RE = /(?:^|\n)FAIL(?:ED)?\b/;
// A trailing success-FORCER that masks the real exit of the command before it: `npm test || true`, `… || :`,
// `… || exit 0`, `… ; true`. The run then reports ok:true no matter how the tests actually exited, so a green
// on such a command doesn't confirm a pass. (A `|| <real retry cmd>` is a legit fallback and is NOT matched —
// only the unconditional force-success forms.) (Fable adversarial FN-2.)
const SWALLOW_RE = /\|\|\s*(?:true|:|exit\s+0|return\s+0)\s*(?:$|[;&|])|;\s*(?:true|:)\s*$/;
const GENERIC_FILTER_RE = /\s(?:--grep|--test-?name-?patterns?)(?:[= ]\S|$)/i;
const RUNNER_FILTERS = [
  [/\bpytest\b|\btox\b/, /\s-k[= ]\S/], [/\bgo test\b/, /\s-run[= ]\S/], [/\bjest\b|\bvitest\b/, /\s-t[= ]\S/],
  [/\bmocha\b|\bplaywright\b|\bcypress\b/, /\s-g[= ]\S/], [/\brspec\b/, /\s(?:-e|--example)[= ]\S/], [/\bdotnet test\b/, /\s--filter[= ]\S/],
];
// only-weak: every test-family SEGMENT of the declared cmd is a syntax/type check (`tsc && npm test` is NOT weak).
const weakOnly = (cmd) => { const ts = String(cmd).split(SHELL_SEG_RE).filter(s => TEST_BUILD_RE.test(s)); return ts.length > 0 && ts.every(s => WEAK_CHECK_RE.test(s)); };
const segFiltered = (cmd) => GENERIC_FILTER_RE.test(cmd) || RUNNER_FILTERS.some(([r, f]) => r.test(cmd) && f.test(cmd));

// Token-boundary-aware "does `hay` contain the command `want`": `want` must sit on TOKEN boundaries so a
// `npm test` claim is NOT blessed by `npm test:watch` / `npm testx` / `npm test-all` — a DIFFERENT command
// that merely has the claim as a prefix (a false green found in the adversarial pass). A boundary is start/
// end or any char outside [\w:.-] (so `:`/`-`/`.` bind the token: test:watch, test-all, test.js don't match).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsCmd = (hay, want) => new RegExp('(?:^|[^\\w:.-])' + escapeRe(want) + '(?:[^\\w:.-]|$)').test(hay);
function commandRun(commands, cmd) {
  const want = norm(cmd);
  return (commands || []).filter(e => {
    const raw = String(e.cmd);
    const masked = raw.replace(/"[^"]*"|'[^']*'/g, (m) => ' '.repeat(m.length));   // quotes → same-length spaces
    // A — whole-command match: `want` appears UNQUOTED (on token boundaries) and the command is not a
    // lookalike. Handles a COMPOUND declared cmd (`tsc && npm test`) the segment split can't, and an exact
    // simple run; the lookalike + mask guards exclude `grep "…npm test…" f` and `echo "npm test"`.
    if (containsCmd(norm(masked), want) && !LOOKALIKE_RE.test(norm(masked))) return true;
    // B — segment match: a simple declared cmd invoked inside a compound run. Split at the UNQUOTED operators
    // (found in `masked`), then classify each segment two ways:
    //   B1 — `want` appears UNQUOTED in the segment (`echo start && npm test`) and it's not a lookalike → run.
    //   B2 — `want` appears only QUOTED, but a shell `-c` INTERPRETER runs it (`bash -c "npm test"`) → run.
    // A quoted `want` under a non-interpreter (grep/find/:/#) matches NEITHER — so a mention neither blesses
    // nor condemns. (Fable adversarial FP-1 / FN-1 / FN-3.)
    const segs = []; let start = 0, m; SPLIT_OP.lastIndex = 0;
    while ((m = SPLIT_OP.exec(masked)) !== null) { segs.push(raw.slice(start, m.index)); start = m.index + m[0].length; }
    segs.push(raw.slice(start));
    return segs.some(seg => {
      const s = norm(seg), ms = norm(seg.replace(/"[^"]*"|'[^']*'/g, (q) => ' '.repeat(q.length)));
      const head = s.replace(/^(?:\w+=\S+\s+)*/, '');   // drop leading env-assignments (`CI=1 pytest …`)
      // A0 — `want` IS the command at this segment's command position (token-bounded). Covers an exact run
      // whose OWN command carries quotes (`pytest -k "not slow"`), which the quote-mask would otherwise hide.
      if (head.startsWith(want) && (head.length === want.length || /[^\w:.-]/.test(head[want.length]))) return true;
      if (containsCmd(ms, want) && !LOOKALIKE_RE.test(ms)) return true;    // B1 — unquoted invocation mid-segment
      if (containsCmd(s, want) && INTERP_RE.test(s)) return true;          // B2 — quoted, under a shell -c
      return false;
    });
  });
}

/**
 * Verify a validated contract against reality. Returns { ok, findings } where each finding is
 *   { cls: 'CA'|'UC', sev, msg, file?, cmd?, symbol?, from?, to?, status? }.
 * Call only on a contract that passed validateContract().
 */
export function verify(contract, reality = {}) {
  const findings = [];
  const files = Array.isArray(reality.files) ? reality.files : [];
  const excluded = typeof reality.excluded === 'function' ? reality.excluded : () => false;
  const byPath = new Map();                       // path → status (last wins; A/M/D)
  const renamePairs = [];                         // {from,to} from R entries
  for (const f of files) {
    if (f.status === 'R') { renamePairs.push({ from: norm(f.from), to: norm(f.path) }); byPath.set(norm(f.path), 'R'); }
    else byPath.set(norm(f.path), f.status);
  }
  const claims = Array.isArray(contract.claims) ? contract.claims : [];

  // ── PASS 1 — claim → reality (CA) ──
  const claimedPaths = new Set();
  for (const c of claims) {
    const file = norm(c.file);
    if (c.t === 'created' || c.t === 'modified' || c.t === 'deleted') {
      claimedPaths.add(file);
      // A claim on an EXCLUDED path (an out-of-repo /tmp scratch, node_modules, a build artifact) can't be
      // verified — such paths are dropped from the diff/untracked scan by design, so they'd read as "absent"
      // and block. UC and NC already abstain on excluded paths; the CA pass must too, for consistency and the
      // founding rule (never a false block). (Fable review C2.)
      if (excluded(file)) continue;
      const st = byPath.get(file);
      // A rename decomposes into (delete FROM) + (create TO): a `deleted <rename-source>` or a
      // `created <rename-target>` claim is TRUE even though the source path isn't in byPath and the target
      // reads as R — so accept those before calling anything absent/mislabeled. (Adversarial pass: a rename
      // declared as delete+create was a block-tier CA "absent".)
      const isRenameFrom = renamePairs.some(p => p.from === file);
      const isRenameTo = renamePairs.some(p => p.to === file);
      if (st === undefined && !isRenameFrom && !isRenameTo) {
        findings.push({ cls: 'CA', sev: SEV_CA, file, msg: `claimed ${c.t} ${file}, but it is absent from the diff` });
        continue;
      }
      // File changed, but the verb disagrees with git's status → softer mislabel signal (modified is the
      // lenient catch-all: any change status satisfies it, so it never mislabels).
      const stWord = (s) => ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }[s] || s);
      if (c.t === 'created' && st !== 'A' && !isRenameTo) findings.push({ cls: 'CA', sev: SEV_SOFT, file, status: st, msg: `claimed created ${file}, but the diff shows it ${stWord(st)}` });
      if (c.t === 'deleted' && st !== 'D' && !isRenameFrom) findings.push({ cls: 'CA', sev: SEV_SOFT, file, status: st, msg: `claimed deleted ${file}, but the diff shows it ${st === undefined ? 'renamed' : stWord(st)}` });
      // Symbols — verify on CREATED only. A `created` file's symbols are all newly-added, so a lexed miss is
      // real. A `modified` file's named symbol may be a PRE-EXISTING function the agent edited (not newly
      // defined), so checking it against added-defs-only would false-CA whenever some other def was added
      // (Fable finding 8). Abstain on modified-symbols, and on any file we couldn't lex.
      if (c.t === 'created' && Array.isArray(c.symbols) && reality.symbolsByFile) {
        const defined = reality.symbolsByFile[file];
        if (Array.isArray(defined)) {
          for (const s of c.symbols) if (!defined.includes(s)) {
            findings.push({ cls: 'CA', sev: SEV_SOFT, file, symbol: s, msg: `claimed symbol ${s} in ${file}, but it is not defined in the added code` });
          }
        }
      }
    } else if (c.t === 'renamed') {
      const from = norm(c.from), to = norm(c.to);
      claimedPaths.add(from); claimedPaths.add(to);
      // git renders a rename either as an R pair OR (below its similarity threshold) as D-from + A-to.
      const asR = renamePairs.some(p => p.from === from && p.to === to);
      const asSplit = byPath.get(from) === 'D' && byPath.get(to) === 'A';
      if (!asR && !asSplit) findings.push({ cls: 'CA', sev: SEV_CA, from, to, msg: `claimed renamed ${from} → ${to}, but the diff does not support it` });
    } else if (c.t === 'tests_pass' || c.t === 'build_pass') {
      if (reality.commands === undefined) continue;          // no transcript → abstain (never a false CA)
      const runs = commandRun(reality.commands, c.cmd);
      if (runs.length === 0) {
        // A matching run in a FILTERED sidechain (a Task subagent's, harness-recorded) means the command DID
        // run this turn — just where the main path can't read its result. Neither bless it (we can't see the
        // outcome) nor block it (an honest orchestrator that delegated the run isn't lying): ABSTAIN. (FP-10.)
        const sc = Array.isArray(reality.sidechainCmds) ? reality.sidechainCmds.map(cmd => ({ cmd, ok: null })) : [];
        if (sc.length && commandRun(sc, c.cmd).length > 0) continue;
        findings.push({ cls: 'CA', sev: SEV_CA, cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but no such command ran this session` }); continue;
      }
      const completed = runs.filter(r => r.ok !== null);    // ok===null = unpaired/in-flight → no verdict
      if (completed.length === 0) continue;                  // matched only unpaired runs → abstain, don't call it a failure
      // Order-aware: the LAST completed matching run is the verdict — a green re-run after edits counts,
      // and a red run after an earlier green is NOT laundered into a pass (Fable finding 5, stale-green).
      const last = completed.reduce((a, b) => (b.seq >= a.seq ? b : a), completed[0]);
      // A LATER matched run than `last` that is unpaired/background means the FINAL outcome is unknown — don't
      // condemn `last`'s red on missing data (v1's unpairedFg gate). (Fable final review, mixed-pairing.)
      const laterUnknown = runs.some(r => r.seq > last.seq && (r.ok === null || r.background));
      if (last.ok !== true) { if (!laterUnknown) findings.push({ cls: 'CA', sev: SEV_CA, cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but the last matching run exited non-zero` }); continue; }
      // GREEN — the Stage-3 sensors (ported from v1 class-1): at most one fires, highest-priority first, all
      // warn/info (a false "you lied about a green run" is worse than a miss). Each ABSTAINS when its input is
      // absent, per the charter.
      const green = completed.filter(r => r.ok === true);
      // stale-green and filtered abstain when ANY matched run is BACKGROUND or UNPAIRED: a background run's
      // completion may postdate the edit (so the green may not actually be stale), and an unpaired run hides a
      // possible later full/fresh run. v1 gated the SESSION this way; `!last.background` alone was dead code
      // (buildReality maps background → ok:null, so `last` is never background). (Fable final review, Issue 1.)
      const ambiguousRun = runs.some(r => r.background || r.ok === null);
      // Test the swallower only against the TAIL from where `want` last appears — a forcer on an EARLIER setup
      // command (`mkdir -p build || true; npm test`) masks THAT command's exit, not the test's, so it must not
      // false-warn an honest green. (Fable review C1.)
      const swTail = (() => { const lc = norm(last.cmd); const i = lc.lastIndexOf(norm(c.cmd)); return i >= 0 ? lc.slice(i) : lc; })();
      if (SWALLOW_RE.test(swTail))
        findings.push({ cls: 'CA', sev: 'warn', cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but the run's exit was force-succeeded (\`|| true\` / \`; true\`) — a zero exit there is manufactured, not a real pass` });
      else if (c.t === 'tests_pass' && weakOnly(c.cmd))
        findings.push({ cls: 'CA', sev: 'warn', cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but that is a syntax/type check, not a test run — verify in the runtime that ships` });
      else if (last.text && (TEST_FAIL_RE.test(last.text) || TEST_FAIL_BANNER_RE.test(last.text)))
        findings.push({ cls: 'CA', sev: 'warn', cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but its output reports failures despite a zero exit — a runner that prints failures and still exits 0 is not a pass` });
      else if (reality.lastEditSeq != null && !ambiguousRun && last.seq > 0 && last.seq < reality.lastEditSeq)
        findings.push({ cls: 'CA', sev: 'warn', cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but the green run predates the last source edit — the green is STALE; re-run after the edit to confirm` });
      else if (!ambiguousRun && !segFiltered(c.cmd) && green.length > 0 && green.every(r => segFiltered(r.cmd)))
        findings.push({ cls: 'CA', sev: 'info', cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but every matching run was FILTERED to a subset — a filtered run cannot back the full \`${c.cmd}\` claim` });
    }
    // deferred: recorded, never verified against the diff (feeds the Week-3 ledger).
    // no_change: contributes no claimed path; a non-empty diff surfaces precisely as UC below.
  }

  // ── PASS 2 — reality → claims (UC) ──
  // Scope to files the AGENT authored this session (its Write/Edit ledger). A file the agent didn't touch —
  // a tree dirty at session start, a manual edit, lockfile churn from `npm install` — is not something it
  // could honestly declare, so flagging it as undeclared is a false positive. `authored === undefined`
  // (no transcript) audits nothing here rather than everything. (Fable finding 7; tests pass `authored`
  // undefined for the pure-unit path, which keeps auditing all — that's the explicit test-only contract.)
  const authored = reality.authored;   // Set | undefined
  const agentTouched = (p) => authored === undefined || authored.has(p);
  for (const f of files) {
    const path = norm(f.path);
    if (excluded(path)) continue;
    // A rename's old side (from) is covered by its rename claim even though it appears as its own D entry.
    if (claimedPaths.has(path)) continue;
    if (f.status === 'R' && claimedPaths.has(norm(f.from))) continue;
    if (!agentTouched(path) && !(f.status === 'R' && agentTouched(norm(f.from)))) continue;
    findings.push({ cls: 'UC', sev: SEV_UC, file: path, status: f.status, msg: `undeclared change: ${path} (${f.status}) is in the diff but no claim covers it` });
  }

  return { ok: findings.length === 0, findings };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────
 * WEEK 3 — the reality builder + the engine-facing orchestrator (still pure; the Stop hook supplies the
 * raw diff / bashEvents / symbol map and flips GROUNDTRUTH_CONTRACT=1).
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

// git quotes a path with special/non-ASCII bytes as "b/caf\303\251.js" (C-style octal escapes of the UTF-8
// bytes, core.quotePath default). Decode so the parsed path matches the repo-relative claim; a non-quoted
// path passes through unchanged. Without this, a non-ASCII filename fails the a/ b/ prefix test → the file
// goes invisible → a CA block on an honest claim (and UC silently abstains). (Fable code-review finding 2.)
function unquotePath(s) {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const inner = s.slice(1, -1), bytes = [], esc = { t: 9, n: 10, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') { bytes.push(inner.charCodeAt(i)); continue; }
    const oct = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    const c = inner[i + 1];
    if (c in esc) { bytes.push(esc[c]); i += 1; continue; }
    bytes.push(inner.charCodeAt(i));
  }
  try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch { return inner; }
}
const stripAB = (p) => (p.startsWith('a/') || p.startsWith('b/')) ? p.slice(2) : p;

/**
 * Parse `reality.files` [{status,path,from?}] from the GIT portion of a unified diff — status is read from
 * the diff's own structure, anchored on the `diff --git` header:
 *   `new file mode`/`--- /dev/null` → A · `deleted file mode`/`+++ /dev/null` → D · `rename from/to` → R ·
 *   `Binary files … differ` and empty new/modified files (which emit NO ---/+++ hunk headers) → resolved
 *   from the diff --git block. Hunk bodies are consumed by the `@@ -a,b +c,d @@` line COUNTS, so an in-hunk
 *   content line that looks like a header (`+++ b/X`, `--- a/X`, `++ b/X`) can never mint a phantom file —
 *   the fix for the agent-controlled-content claim-laundering the naive `inHunk` boolean allowed (Fable re-review round 3, Issue 2).
 *
 * It deliberately does NOT parse bare tool-ledger `+++ b/` fragments: those paths are agent-controllable
 * content, so untracked creates are instead added from the AUTHORITATIVE Write/Edit ledger in buildReality.
 */
export function filesFromDiff(diff) {
  const byPath = new Map();          // path → status (A/M/D)
  const renames = [];                // {from,to}
  const renamed = new Set();
  let cur = null;                    // current `diff --git` block
  let prevMinus = false;             // the previous line was this block's git `--- ` header (so the next `+++ ` is its pair)
  let remOld = 0, remNew = 0;        // hunk lines still to consume on the old/new side (exact @@ counting)
  const flush = () => {
    if (!cur) return;
    const b = cur; cur = null;
    if (b.rFrom != null && b.rTo != null) { renames.push({ from: b.rFrom, to: b.rTo }); renamed.add(b.rFrom); renamed.add(b.rTo); return; }
    const path = (b.deleted || b.plus === '/dev/null') ? (b.minus || b.aPath)
      : (b.plus || b.bPath || b.aPath);
    if (!path) return;
    const status = (b.deleted || b.plus === '/dev/null') ? 'D'
      : (b.added || b.minus === '/dev/null') ? 'A' : 'M';   // binary/empty fall through to A (if new) or M
    byPath.set(path, status);
  };
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      // split on the LAST ` b/` so an UNQUOTED path with spaces (`a/my file.js b/my file.js`) parses; quoted
      // and normal paths fall back to the greedy two-token split.
      const rest = line.slice(11); const bi = rest.startsWith('a/') ? rest.lastIndexOf(' b/') : -1;
      const [aRaw, bRaw] = bi > 0 ? [rest.slice(0, bi), rest.slice(bi + 1)] : (rest.match(/^(.+) (.+)$/)?.slice(1) || [rest, rest]);
      cur = { aPath: stripAB(unquotePath(aRaw)), bPath: stripAB(unquotePath(bRaw)) }; prevMinus = false; remOld = 0; remNew = 0; continue;
    }
    const hm = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hm) { remOld = hm[1] === undefined ? 1 : +hm[1]; remNew = hm[2] === undefined ? 1 : +hm[2]; prevMinus = false; continue; }
    if (remOld > 0 || remNew > 0) {           // inside a hunk body → consume by count, never reinterpret
      const c = line[0];
      if (c === '\\') { /* "\ No newline at end of file" — counts for neither side */ }
      else if (c === '-') remOld--;
      else if (c === '+') remNew--;
      else { remOld--; remNew--; }            // context (space) or blank line
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur) { const r = unquotePath(line.slice(4).trim()); cur.minus = r === '/dev/null' ? '/dev/null' : (r.startsWith('a/') ? r.slice(2) : cur.minus); prevMinus = true; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      // ONLY a git header pair (directly after this block's `--- `) sets the path; a stray `+++ ` (a tool-ledger
      // fragment line, or content past the hunk) is ignored — ledger creates come from `authored` in buildReality.
      if (cur && prevMinus) { const r = unquotePath(line.slice(4).trim()); cur.plus = r === '/dev/null' ? '/dev/null' : (r.startsWith('b/') ? r.slice(2) : cur.plus); }
      prevMinus = false; continue;
    }
    if (cur) {
      if (line.startsWith('new file mode')) cur.added = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      // git's `rename from`/`rename to` lines are NEVER a/ b/-prefixed (unlike the `--- `/`+++ ` header pair),
      // so stripAB must NOT run here — it silently mangles a real leading `a/`/`b/` DIRECTORY (a repo with a
      // top-level dir literally named `a` or `b`): `rename from a/x.js` → `x.js` → the honest rename claim
      // reads as unsupported → block-tier CA + a UC on the mangled path. (Fable adversarial FP-2.)
      else if (line.startsWith('rename from ')) cur.rFrom = unquotePath(line.slice(12).trim());
      else if (line.startsWith('rename to ')) cur.rTo = unquotePath(line.slice(10).trim());
    }
    prevMinus = false;
  }
  flush();
  const files = [];
  for (const { from, to } of renames) files.push({ status: 'R', from, path: to });
  for (const [path, status] of byPath) if (!renamed.has(path)) files.push({ status, path });
  return files;
}

// Relativize a diff/ledger path against cwd (backslashes normalized). The tool-ledger records ABSOLUTE
// Write/Edit file_paths (`+++ b//abs/path`), but a claim is repo-relative — without this they never
// string-match and every honest `created` claim for a new file is a CA BLOCK. (Fable finding 1.)
function relativize(p, cwd) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (c && s.startsWith(c + '/')) s = s.slice(c.length + 1);
  return s;
}

/**
 * Assemble the normalized `reality` the verifier consumes, from raw engine inputs. Pure — the Stop hook
 * passes the real diff, transcript bashEvents, a lexed symbol map, an exclusion predicate, cwd (to
 * relativize tool-ledger paths), and the set of files the agent's Write/Edit tools authored (for UC scope).
 *
 * `bashEvents === undefined` (no/unparseable transcript) ⇒ `commands: undefined` ⇒ verify ABSTAINS on
 * test/build claims. An empty array means a transcript with no commands (a real "nothing ran"). This
 * distinction is why a truthful `tests_pass` on the fail-open path is no longer a false CA. (Fable finding 3.)
 */
export function buildReality({ diff = '', bashEvents = undefined, symbolsByFile = undefined, excluded = () => false, cwd = '', authored = undefined, lastEditSeq = undefined, untracked = undefined, sidechainCmds = undefined, openDeferrals = undefined } = {}) {
  const commands = bashEvents === undefined ? undefined : (bashEvents || [])
    .filter(e => e && typeof e.cmd === 'string')
    .map(e => ({
      cmd: e.cmd,
      // tri-state; null ⇒ abstain. A BACKGROUND run's is_error:false is only a launch-ack, not a completed
      // pass, so it must NOT bless a tests_pass claim (v1 abstains on background test runs). (Fable re-review, finding 3.)
      ok: e.background === true ? null : (e.is_error === false ? true : e.is_error === true ? false : null),
      background: e.background === true,
      seq: typeof e.seq === 'number' ? e.seq : 0,
      text: typeof e.text === 'string' ? e.text : '',   // run output — the failure-substring sensor reads it
    }));
  const rel = (p) => relativize(p, cwd);
  const gitFiles = filesFromDiff(diff).map(f => (f.from != null ? { ...f, path: rel(f.path), from: rel(f.from) } : { ...f, path: rel(f.path) }));
  const authoredSet = authored === undefined ? undefined : new Set((authored || []).map(rel));
  // Untracked creates the agent authored via Write don't show in `git diff` (untracked), so add them from the
  // AUTHORITATIVE ledger — NOT by parsing `+++ b/` fragments out of the diff, whose paths are agent-controllable
  // content a planted `++ b/ghost.js` line could forge to launder a false `created` claim. (Fable round 3, Issue 2.)
  const files = [...gitFiles];
  const seen = new Set();
  for (const f of gitFiles) { seen.add(f.path); if (f.from != null) seen.add(f.from); }   // a rename's OLD path too, so an authored edit-then-`git mv` doesn't re-add a phantom A
  // Synthetic `A` for a NEW file `git diff <ref>` misses because it's UNTRACKED. The authoritative signal is
  // DISK PRESENCE — the untracked set (git `??` entries). Gating on it kills three defects the old ledger-only
  // mint caused: an edit-then-REVERT (tracked, no net diff → not untracked → no phantom A, so `no_change` is
  // clean — FP-5); a Write-then-`rm` (gone → not untracked → a `created` claim correctly finds nothing — FN-5);
  // and a heredoc/scaffolder create (untracked-present but NOT in the Write/Edit ledger → now surfaced, so an
  // honest `created` claim doesn't block — FP-8). When `untracked` is unknown (unit tests / no-git fail-open),
  // fall back to the ledger mint so `created` claims still verify off-transcript. UC stays authored-scoped, so
  // a non-ledger untracked file surfaced here never becomes a false UC.
  const untrackedSet = untracked == null ? undefined : new Set((untracked || []).map(rel));   // null (git unknown) ⇒ ledger fallback
  if (untrackedSet) {
    for (const p of untrackedSet) if (p && !seen.has(p)) { files.push({ status: 'A', path: p }); seen.add(p); }
  } else if (authoredSet) {
    for (const p of authoredSet) if (p && !seen.has(p)) files.push({ status: 'A', path: p });
  }
  return { files, commands, symbolsByFile, excluded, authored: authoredSet, lastEditSeq, sidechainCmds, openDeferrals };
}

// Contract-finding severities. NC is WARN by default (deliberately conservative — a repo touched by an
// agent that never saw the contract instruction, e.g. a teammate's plain session, would otherwise NC-block
// every turn; scoping NC-block to contract-aware sessions is a follow-up). CA/UC keep verify()'s severities.
const SEV_NC = 'warn';

/**
 * The single entry the Stop hook calls (behind GROUNDTRUTH_CONTRACT=1). Returns findings in the engine's
 * `{ cls, sev, msg }` shape so they flow through the existing card / block-loop / history unchanged:
 *   NC — no valid contract (missing / malformed / schema-invalid)   [warn]
 *   CA — a claim the diff/transcript don't support                   [block, soft mislabels warn]
 *   UC — a changed file no claim covers                              [warn]
 * Fail-open by construction: any unexpected shape yields an empty array upstream (the hook wraps in try).
 */
export function contractFindings(message, reality = {}) {
  const a = analyze(message);
  if (!a.ok) {
    // Only NC when the agent AUTHORED changes it should have declared. A turn that changed nothing the agent
    // touched — pure Q&A, an observation, a read-only turn — needs no contract, so a missing block abstains
    // rather than warning. Without this, contract-default nags EVERY block-less turn = training-to-ignore
    // (Fable finding 6). Scope matches UC: authored files if we have the ledger, else the whole diff.
    const files = Array.isArray(reality.files) ? reality.files : [];
    const authored = reality.authored;   // Set | undefined
    // Mirror the UC pass's exclusion: a path GroundTruth would never audit (an out-of-repo /tmp scratch file,
    // node_modules, a build artifact) is not something the agent could declare, so its presence must not force
    // an NC nag on an otherwise read-only turn. The UC pass filtered it; NC didn't — a Q&A turn whose only
    // Write was `/tmp/scratch/calc.py` got nagged. (Fable adversarial FP-4.)
    const excluded = typeof reality.excluded === 'function' ? reality.excluded : () => false;
    const declarable = (authored === undefined ? files
      : files.filter(f => authored.has(norm(f.path)) || (f.status === 'R' && authored.has(norm(f.from)))))
      .filter(f => !excluded(norm(f.path)));
    if (declarable.length === 0) return [];
    // NC: surface the first concrete reason (not the whole SCHEMA_HELP block — that goes to the block handback).
    return [{ cls: 'NC', sev: SEV_NC, msg: `no valid ${FENCE_TAG} block — ${a.errors[0] || 'missing'}` }];
  }
  const out = verify(a.contract, reality).findings.map(f => ({ cls: f.cls, sev: f.sev, msg: f.msg }));
  // Surface DECLARED deferrals (spec §6: declaration, not prose extraction). Warn-tier + honest — the agent
  // named what it set aside, so it's visible, never silent (mirrors v1's human-confirmed deferral line).
  // MULTI-TURN: if the Stop hook supplies `reality.openDeferrals` (the session-wide OPEN set reconstructed from
  // the transcript), surface THAT — a deferral declared on an earlier turn stays visible until closed, so it
  // can't silently vanish by being omitted next turn. Absent it (pure-unit path), fall back to THIS turn's
  // deferrals (unchanged single-turn behavior).
  const deferredSrc = Array.isArray(reality.openDeferrals)
    ? reality.openDeferrals
    : a.contract.claims.filter(c => c && c.t === 'deferred');
  for (const d of deferredSrc) out.push({ cls: 'deferred', sev: 'warn', msg: deferralMsg(d) });
  return out;
}

// Consistent card line for a deferral (both the single-turn and multi-turn paths render identically).
export const deferralMsg = (d) => `deferred (declared) — ${d.what}${d.why ? ` — ${d.why}` : ''}`;

// Reconstruct the still-OPEN deferrals across the session from the ordered list of past+current CONTRACTS
// (parsed from the transcript — the unforgeable harness record, so a declared set-aside can't silently vanish
// by omission next turn; restores spec §6's multi-turn tracking WITHOUT a forgeable ledger — the v1 tasks.json
// was agent-writable, exactly what v2 rejects). Keyed by the normalized `what`. A deferral CLOSES only on a
// STRONG signal that a later turn did the work: its full normalized `what` appears as a substring of a
// completing claim's descriptor (file/cmd/symbol) or the turn's task. Closure is deliberately conservative —
// a missed close leaves a stale deferral on the card (a harmless warn, the agent's own admission), whereas a
// false close would SILENTLY DROP a real open loop (the bad direction). Session-scoped by construction (a new
// session = a fresh transcript = a fresh ledger). Pure → directly unit-testable.
const nlow = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
export function openDeferrals(contracts) {
  const open = new Map();   // key: normalized `what` → { what, why }
  for (const c of (Array.isArray(contracts) ? contracts : [])) {
    const claims = Array.isArray(c && c.claims) ? c.claims : [];
    // (1) close open deferrals this turn's COMPLETING work clearly satisfies (strict substring containment).
    const done = claims.filter(x => x && x.t !== 'deferred' && x.t !== 'no_change')
      .flatMap(x => [x.file, x.from, x.to, x.cmd, ...(Array.isArray(x.symbols) ? x.symbols : [])])
      .filter(isNonEmptyStr).map(nlow);
    const task = nlow(c && c.task);
    for (const key of [...open.keys()]) {
      if (key.length < 4) continue;                       // too short to match safely → keep open
      if (done.some(d => d.includes(key)) || (task && task.includes(key))) open.delete(key);
    }
    // (2) open / refresh deferrals declared this turn — re-declaring KEEPS it open even if (1) just matched.
    for (const x of claims) {
      if (x && x.t === 'deferred' && isNonEmptyStr(x.what)) open.set(nlow(x.what), { what: x.what, why: isNonEmptyStr(x.why) ? x.why : '' });
    }
  }
  return [...open.values()];
}
