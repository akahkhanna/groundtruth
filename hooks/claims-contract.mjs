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
  if (typeof message !== 'string' || message.length === 0) return { raw: null, count: 0 };
  FENCE_RE.lastIndex = 0;
  let m, last = null, count = 0;
  while ((m = FENCE_RE.exec(message)) !== null) { last = m[1]; count++; }
  return { raw: last, count };
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

  const parsed = parseContract(message);
  if (!parsed.ok) return nc([parsed.error], parsed.count);

  const v = validateContract(parsed.value);
  if (!v.ok) return nc(v.errors, parsed.count);

  return { ok: true, code: null, reason: null, contract: v.contract, errors: [], count: parsed.count };
}
