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

const norm = (p) => String(p == null ? '' : p).trim();

// Does a tests_pass/build_pass claim's cmd correspond to a command that actually ran? Match on exact cmd
// or an executed command that CONTAINS it (tolerates wrapper flags: `npm test` vs `npm test -- --ci`).
function commandRun(commands, cmd) {
  const want = norm(cmd);
  return (commands || []).filter(e => { const c = norm(e.cmd); return c === want || c.includes(want); });
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
      const st = byPath.get(file);
      if (st === undefined) {
        findings.push({ cls: 'CA', sev: SEV_CA, file, msg: `claimed ${c.t} ${file}, but it is absent from the diff` });
        continue;
      }
      // File changed, but the verb disagrees with git's status → softer mislabel signal (modified is the
      // lenient catch-all: any change status satisfies it, so it never mislabels).
      if (c.t === 'created' && st !== 'A') findings.push({ cls: 'CA', sev: SEV_SOFT, file, status: st, msg: `claimed created ${file}, but the diff shows it ${st === 'M' ? 'modified' : st === 'D' ? 'deleted' : st}` });
      if (c.t === 'deleted' && st !== 'D') findings.push({ cls: 'CA', sev: SEV_SOFT, file, status: st, msg: `claimed deleted ${file}, but the diff shows it ${st === 'A' ? 'added' : st === 'M' ? 'modified' : st}` });
      // Symbols (created/modified only) — abstain unless we were handed a lexed map for this file.
      if ((c.t === 'created' || c.t === 'modified') && Array.isArray(c.symbols) && reality.symbolsByFile) {
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
      if (reality.commands === undefined) continue;          // no transcript → abstain
      const runs = commandRun(reality.commands, c.cmd);
      if (runs.length === 0) findings.push({ cls: 'CA', sev: SEV_CA, cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but no such command ran this session` });
      else if (!runs.some(r => r.ok)) findings.push({ cls: 'CA', sev: SEV_CA, cmd: c.cmd, msg: `claimed \`${c.cmd}\` passed, but it exited non-zero` });
    }
    // deferred: recorded, never verified against the diff (feeds the Week-3 ledger).
    // no_change: contributes no claimed path; a non-empty diff surfaces precisely as UC below.
  }

  // ── PASS 2 — reality → claims (UC) ──
  for (const f of files) {
    const path = norm(f.path);
    if (excluded(path)) continue;
    // A rename's old side (from) is covered by its rename claim even though it appears as its own D entry.
    if (claimedPaths.has(path)) continue;
    if (f.status === 'R' && claimedPaths.has(norm(f.from))) continue;
    findings.push({ cls: 'UC', sev: SEV_UC, file: path, status: f.status, msg: `undeclared change: ${path} (${f.status}) is in the diff but no claim covers it` });
  }

  return { ok: findings.length === 0, findings };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────
 * WEEK 3 — the reality builder + the engine-facing orchestrator (still pure; the Stop hook supplies the
 * raw diff / bashEvents / symbol map and flips GROUNDTRUTH_CONTRACT=1).
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Parse `reality.files` [{status,path,from?}] straight from a unified diff — the SAME authored diff the
 * engine already computes (git diff + the tool-ledger merge), so untracked files the agent just created
 * are visible without a second git call. Status is read from the diff's own structure:
 *   `--- /dev/null` → A  ·  `+++ /dev/null` → D  ·  `rename from/to` → R  ·  otherwise M.
 * A bare `+++ b/path` with no `--- ` header (a tool-ledger fragment for a new file) reads as A.
 * Gated on the a/ b/ /dev/null prefixes (git's convention, matching the engine's changedFiles) so a removed
 * CONTENT line that merely starts with dashes is never mistaken for a file header. Last status per path wins.
 */
export function filesFromDiff(diff) {
  const byPath = new Map();          // path → status (A/M/D)
  const renames = [];                // {from,to}
  const renamed = new Set();         // paths owned by a rename (skip A/M/D for them)
  let minus = null, rFrom = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('rename from ')) { rFrom = line.slice(12).trim(); continue; }
    if (line.startsWith('rename to ')) {
      const to = line.slice(10).trim();
      if (rFrom != null) { renames.push({ from: rFrom, to }); renamed.add(rFrom); renamed.add(to); rFrom = null; }
      continue;
    }
    if (line.startsWith('--- ')) {
      const rest = line.slice(4).trim();
      minus = rest === '/dev/null' ? '/dev/null' : (rest.startsWith('a/') ? rest.slice(2) : null);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const rest = line.slice(4).trim();
      const plus = rest === '/dev/null' ? '/dev/null' : (rest.startsWith('b/') ? rest.slice(2) : null);
      if (plus === '/dev/null') { if (minus && minus !== '/dev/null') byPath.set(minus, 'D'); }
      else if (plus) byPath.set(plus, (minus === '/dev/null' || minus === null) ? 'A' : 'M');
      minus = null;
      continue;
    }
  }
  const files = [];
  for (const { from, to } of renames) files.push({ status: 'R', from, path: to });
  for (const [path, status] of byPath) if (!renamed.has(path)) files.push({ status, path });
  return files;
}

/**
 * Assemble the normalized `reality` the verifier consumes, from raw engine inputs. Pure — the Stop hook
 * passes the real diff, transcript bashEvents, a lexed symbol map, and an exclusion predicate.
 */
export function buildReality({ diff = '', bashEvents = [], symbolsByFile = undefined, excluded = () => false } = {}) {
  const commands = (bashEvents || [])
    .filter(e => e && typeof e.cmd === 'string' && e.background !== true)   // background runs have no final status
    .map(e => ({ cmd: e.cmd, ok: e.is_error === false }));                  // ok ONLY on a recorded zero exit
  return { files: filesFromDiff(diff), commands, symbolsByFile, excluded };
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
    // NC: surface the first concrete reason (not the whole SCHEMA_HELP block — that goes to the block handback).
    return [{ cls: 'NC', sev: SEV_NC, msg: `no valid ${FENCE_TAG} block — ${a.errors[0] || 'missing'}` }];
  }
  const out = verify(a.contract, reality).findings.map(f => ({ cls: f.cls, sev: f.sev, msg: f.msg }));
  // Surface DECLARED deferrals as the task ledger's replacement (spec §6: declaration, not prose extraction).
  // Warn-tier + honest — the agent named what it set aside, so it's visible, never silent (mirrors v1's
  // human-confirmed deferral line). A deferral stays the agent's own admission, not a caught lie.
  for (const c of a.contract.claims) {
    if (c.t === 'deferred') out.push({ cls: 'deferred', sev: 'warn', msg: `deferred (declared) — ${c.what}${c.why ? ` — ${c.why}` : ''}` });
  }
  return out;
}
