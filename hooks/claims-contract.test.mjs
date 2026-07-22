#!/usr/bin/env node
/**
 * claims-contract.test.mjs — self-check for the Groundtruth v2 claims contract (run: `node claims-contract.test.mjs`).
 * Fixture corpus: valid blocks (every claim type), malformed JSON, each schema rule, and the fence parser
 * (missing / multiple / CRLF / prose-wrapped / extra backticks). assert-based, no deps — a thrown assert
 * fails loud with the label.
 */
import assert from 'node:assert';
import {
  analyze, parseContract, validateContract, verify, findClaimsBlock, isValidPath,
  filesFromDiff, buildReality, contractFindings,
  CONTRACT_VERSION, STATUSES, CLAIM_TYPES, FENCE_TAG, SCHEMA_HELP,
} from './claims-contract.mjs';

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

// Wrap a JSON string in a claims fence, optionally with surrounding prose and a chosen fence width.
const block = (json, { pre = '', post = '', ticks = 3 } = {}) => {
  const f = '`'.repeat(ticks);
  return `${pre}${pre ? '\n' : ''}${f}${FENCE_TAG}\n${json}\n${f}${post ? '\n' + post : ''}`;
};
const good = (over = {}) => JSON.stringify({
  v: 1, task: 'add auth middleware', status: 'complete',
  claims: [{ t: 'created', file: 'src/auth.mjs', symbols: ['requireAuth'] }],
  ...over,
});

// ── fence parser ──
ok('finds a block wrapped in prose', findClaimsBlock(block(good(), { pre: 'Done.', post: 'Anything else?' })).count === 1);
ok('no block → count 0, raw null', (() => { const r = findClaimsBlock('just an essay, no fence'); return r.count === 0 && r.raw === null; })());
ok('non-string message → count 0', findClaimsBlock(undefined).count === 0);
ok('extra backticks (4) still parse', analyze(block(good(), { ticks: 4 })).ok);
ok('CRLF line endings parse', analyze(block(good()).replace(/\n/g, '\r\n')).ok);
{
  // two blocks in one message → LAST wins (the end-of-turn block is authoritative)
  const two = block(good({ task: 'FIRST' })) + '\n\n' + block(good({ task: 'SECOND' }));
  const r = analyze(two);
  ok('multiple blocks: count reflects both', r.count === 2);
  ok('multiple blocks: last block wins', r.ok && r.contract.task === 'SECOND');
}

// ── malformed vs schema-invalid are distinguishable ──
ok('malformed JSON → parse fails, NC', (() => {
  const p = parseContract(block('{ "v": 1, task: nope }'));
  const a = analyze(block('{ "v": 1, task: nope }'));
  return !p.ok && /malformed JSON/.test(p.error) && a.code === 'NC';
})());
ok('well-formed JSON but bad schema → parse OK, validate fails', (() => {
  const p = parseContract(block('{ "v": 1 }'));
  return p.ok && !validateContract(p.value).ok;
})());

// ── happy path: a valid contract ──
{
  const a = analyze(block(good()));
  ok('valid contract → ok, code null, no errors', a.ok && a.code === null && a.errors.length === 0);
  ok('valid contract → returns normalized {v,task,status,claims}', a.contract.v === 1 && a.contract.status === 'complete' && Array.isArray(a.contract.claims));
}

// ── every claim type validates in isolation ──
const oneClaim = (c, status = 'complete', extra = {}) =>
  validateContract({ v: 1, task: 't', status, claims: [c], ...extra });
ok('created (with symbols) valid', oneClaim({ t: 'created', file: 'a.mjs', symbols: ['x'] }).ok);
ok('created (symbols omitted) valid — symbols optional', oneClaim({ t: 'created', file: 'a.mjs' }).ok);
ok('modified valid', oneClaim({ t: 'modified', file: 'a.mjs' }).ok);
ok('deleted valid', oneClaim({ t: 'deleted', file: 'a.mjs' }).ok);
ok('renamed (from+to) valid', oneClaim({ t: 'renamed', from: 'a.mjs', to: 'b.mjs' }).ok);
ok('tests_pass valid', oneClaim({ t: 'tests_pass', cmd: 'npm test' }).ok);
ok('build_pass valid', oneClaim({ t: 'build_pass', cmd: 'npm run build' }).ok);
ok('deferred (partial) valid', oneClaim({ t: 'deferred', what: 'e2e', why: 'no staging' }, 'partial').ok);
ok('no_change valid', oneClaim({ t: 'no_change' }).ok);
ok('empty claims array is valid (pure Q&A turn)', validateContract({ v: 1, task: 't', status: 'complete', claims: [] }).ok);

// ── schema rejections, one rule each ──
const rejects = (obj, needle) => { const r = validateContract(obj); return !r.ok && r.errors.some(e => e.includes(needle)); };
ok('wrong version rejected', rejects({ v: 2, task: 't', status: 'complete', claims: [] }, '"v" must be'));
ok('empty task rejected', rejects({ v: 1, task: '   ', status: 'complete', claims: [] }, '"task"'));
ok('unknown status rejected', rejects({ v: 1, task: 't', status: 'done', claims: [] }, '"status"'));
ok('non-array claims rejected', rejects({ v: 1, task: 't', status: 'complete', claims: {} }, '"claims" must be an array'));
ok('unknown claim type rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'refactored', file: 'a' }] }, 'not a known claim type'));
ok('created missing file rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'created' }] }, '.file must be a repo-relative path'));
ok('renamed missing to rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'renamed', from: 'a' }] }, '.to must be a repo-relative path'));
ok('tests_pass missing cmd rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'tests_pass' }] }, '.cmd must be a non-empty string'));
ok('deferred missing why rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'deferred', what: 'x' }] }, '.why must be a non-empty string'));
ok('bad symbols type rejected', rejects({ v: 1, task: 't', status: 'complete', claims: [{ t: 'created', file: 'a', symbols: 'x' }] }, '.symbols must be an array'));

// ── cross-field: partial/blocked must carry a deferred ──
ok('partial without deferred rejected', rejects({ v: 1, task: 't', status: 'partial', claims: [{ t: 'created', file: 'a' }] }, 'requires at least one "deferred"'));
ok('blocked without deferred rejected', rejects({ v: 1, task: 't', status: 'blocked', claims: [] }, 'requires at least one "deferred"'));
ok('blocked WITH deferred accepted', validateContract({ v: 1, task: 't', status: 'blocked', claims: [{ t: 'deferred', what: 'x', why: 'y' }] }).ok);

// ── path shape ──
ok('relative path valid', isValidPath('src/a.mjs'));
ok('absolute path invalid', !isValidPath('/etc/passwd'));
ok('empty path invalid', !isValidPath('   '));
ok('NUL-byte path invalid', !isValidPath('a\0b'));
ok('newline in path invalid', !isValidPath('a\nb'));

// ── NC handback carries the schema help (Week-3 block loop feeds this back verbatim) ──
{
  const a = analyze('no block here at all');
  ok('NC on missing block', a.code === 'NC' && !a.ok);
  ok('NC reason embeds SCHEMA_HELP so the agent can self-correct', a.reason.includes(SCHEMA_HELP) && a.reason.includes(FENCE_TAG));
}

// ── the constants the schema advertises are internally consistent ──
ok('CONTRACT_VERSION is 1', CONTRACT_VERSION === 1);
ok('every advertised claim type has a spec', Object.keys(CLAIM_TYPES).length === 8);
ok('SCHEMA_HELP names every status', STATUSES.every(s => SCHEMA_HELP.includes(s)));

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WEEK 2 — verify() : the CA / UC pincer
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const contract = (claims, status = 'complete') => ({ v: 1, task: 't', status, claims });
const has = (r, cls, needle) => r.findings.some(f => f.cls === cls && (!needle || f.msg.includes(needle)));

// ── clean: every claim matches reality, whole diff covered → ok ──
{
  const r = verify(
    contract([{ t: 'created', file: 'a.mjs' }, { t: 'modified', file: 'b.mjs' }, { t: 'tests_pass', cmd: 'npm test' }]),
    { files: [{ status: 'A', path: 'a.mjs' }, { status: 'M', path: 'b.mjs' }], commands: [{ cmd: 'npm test', ok: true }] },
  );
  ok('clean contract vs matching reality → ok, no findings', r.ok && r.findings.length === 0);
}

// ── CA: claimed file absent from diff (the silent no-op catch) ──
ok('CA: created file absent → block', has(verify(contract([{ t: 'created', file: 'ghost.mjs' }]), { files: [] }), 'CA', 'absent from the diff'));
ok('CA: modified file absent → block', has(verify(contract([{ t: 'modified', file: 'ghost.mjs' }]), { files: [{ status: 'A', path: 'other.mjs' }] }), 'CA', 'absent'));

// ── CA (soft): file changed but the verb disagrees with git status ──
ok('CA soft: created but diff shows modified', (() => {
  const f = verify(contract([{ t: 'created', file: 'a.mjs' }]), { files: [{ status: 'M', path: 'a.mjs' }] }).findings.find(x => x.file === 'a.mjs');
  return f && f.sev === 'warn' && /shows it modified/.test(f.msg);
})());
ok('CA soft: deleted but diff shows added', has(verify(contract([{ t: 'deleted', file: 'a.mjs' }]), { files: [{ status: 'A', path: 'a.mjs' }] }), 'CA', 'shows it added'));
ok('modified is the lenient catch-all: file added satisfies it (no mislabel)', (() => {
  const r = verify(contract([{ t: 'modified', file: 'a.mjs' }]), { files: [{ status: 'A', path: 'a.mjs' }] });
  return !r.findings.some(f => f.cls === 'CA');   // covered → no CA; also no UC (claimed)
})());

// ── CA: renames — R form, split D+A form, and unsupported ──
ok('renamed as an R pair → clean', verify(contract([{ t: 'renamed', from: 'old.mjs', to: 'new.mjs' }]), { files: [{ status: 'R', from: 'old.mjs', path: 'new.mjs' }] }).ok);
ok('renamed rendered as D+A (below git similarity) → clean', verify(contract([{ t: 'renamed', from: 'old.mjs', to: 'new.mjs' }]), { files: [{ status: 'D', path: 'old.mjs' }, { status: 'A', path: 'new.mjs' }] }).ok);
ok('CA: renamed unsupported by diff → block', has(verify(contract([{ t: 'renamed', from: 'old.mjs', to: 'new.mjs' }]), { files: [{ status: 'M', path: 'unrelated.mjs' }] }), 'CA', 'does not support'));

// ── CA: tests_pass / build_pass against transcript bash evidence ──
ok('tests_pass matched to a green run → clean', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true }] }).ok);
ok('tests_pass tolerates wrapper flags on the executed cmd', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test -- --ci', ok: true }] }).ok);
ok('CA: tests_pass but no such command ran → block', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm run lint', ok: true }] }), 'CA', 'no such command ran'));
ok('CA: tests_pass but the run failed → block', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: false }] }), 'CA', 'exited non-zero'));
ok('ABSTAIN: no transcript (commands undefined) → no tests_pass finding', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [] }).ok);

// ── CA: symbol claims (created/modified) against a lexed per-file map ──
ok('symbol present in added code → clean', verify(contract([{ t: 'created', file: 'a.mjs', symbols: ['foo'] }]), { files: [{ status: 'A', path: 'a.mjs' }], symbolsByFile: { 'a.mjs': ['foo', 'bar'] } }).ok);
ok('CA soft: claimed symbol not in added code', has(verify(contract([{ t: 'created', file: 'a.mjs', symbols: ['nope'] }]), { files: [{ status: 'A', path: 'a.mjs' }], symbolsByFile: { 'a.mjs': ['foo'] } }), 'CA', 'not defined in the added code'));
ok('ABSTAIN: symbolsByFile omitted → no symbol finding', verify(contract([{ t: 'created', file: 'a.mjs', symbols: ['x'] }]), { files: [{ status: 'A', path: 'a.mjs' }] }).ok);
ok('ABSTAIN: file not in the lexed map (unlexable lang) → no symbol finding', verify(contract([{ t: 'created', file: 'a.rs', symbols: ['x'] }]), { files: [{ status: 'A', path: 'a.rs' }], symbolsByFile: {} }).ok);

// ── UC: a changed file no claim covers (the new capability) ──
ok('UC: undeclared changed file → warn', has(verify(contract([{ t: 'modified', file: 'a.mjs' }]), { files: [{ status: 'M', path: 'a.mjs' }, { status: 'M', path: 'sneaky.mjs' }] }), 'UC', 'no claim covers it'));
ok('UC: excluded paths (lockfiles/generated) are skipped', verify(contract([{ t: 'modified', file: 'a.mjs' }]), { files: [{ status: 'M', path: 'a.mjs' }, { status: 'M', path: 'pnpm-lock.yaml' }], excluded: (p) => p.endsWith('lock.yaml') }).ok);
ok('UC: a rename claim covers BOTH its from and to sides', verify(contract([{ t: 'renamed', from: 'old.mjs', to: 'new.mjs' }]), { files: [{ status: 'D', path: 'old.mjs' }, { status: 'A', path: 'new.mjs' }] }).ok);

// ── no_change & deferred ──
ok('no_change + empty diff → clean (the frictionless Q&A turn)', verify(contract([{ t: 'no_change' }]), { files: [] }).ok);
ok('no_change but the diff is non-empty → surfaces as UC', has(verify(contract([{ t: 'no_change' }]), { files: [{ status: 'M', path: 'a.mjs' }] }), 'UC'));
ok('deferred produces no verify finding (recorded, not audited here)', verify(contract([{ t: 'deferred', what: 'e2e', why: 'no staging' }], 'partial'), { files: [] }).ok);

// ── the pincer: omission fires UC, invention fires CA, in the SAME turn ──
{
  const r = verify(
    contract([{ t: 'created', file: 'claimed-but-never-written.mjs' }]),
    { files: [{ status: 'M', path: 'actually-changed.mjs' }] },
  );
  ok('pincer: invention → CA and omission → UC together', has(r, 'CA', 'absent') && has(r, 'UC', 'actually-changed.mjs'));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WEEK 3 — filesFromDiff / buildReality / contractFindings (the engine seam, still pure)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

// ── filesFromDiff: status straight from unified-diff structure ──
{
  const files = filesFromDiff([
    'diff --git a/new.mjs b/new.mjs', 'new file mode 100644', '--- /dev/null', '+++ b/new.mjs', '+export function foo(){}',
    'diff --git a/mod.mjs b/mod.mjs', '--- a/mod.mjs', '+++ b/mod.mjs', '@@ -1 +1 @@', '-old', '+new',
    'diff --git a/gone.mjs b/gone.mjs', 'deleted file mode 100644', '--- a/gone.mjs', '+++ /dev/null', '-bye',
    'diff --git a/old.mjs b/ren.mjs', 'similarity index 90%', 'rename from old.mjs', 'rename to ren.mjs',
  ].join('\n'));
  const get = (p) => files.find(f => f.path === p);
  ok('filesFromDiff: new file → A', get('new.mjs')?.status === 'A');
  ok('filesFromDiff: modified → M', get('mod.mjs')?.status === 'M');
  ok('filesFromDiff: deleted → D', get('gone.mjs')?.status === 'D');
  ok('filesFromDiff: rename → R with from', (() => { const r = get('ren.mjs'); return r?.status === 'R' && r.from === 'old.mjs'; })());
}
ok('filesFromDiff: bare +++ b/ (tool-ledger fragment, no --- header) → A', filesFromDiff('+++ b/created.mjs\n+line').find(f => f.path === 'created.mjs')?.status === 'A');
ok('filesFromDiff: a removed content line starting with dashes is NOT a file header', (() => {
  // `--- x` here is a REMOVED markdown rule inside a hunk (prefix `-` + `-- x`), not an `--- a/` header.
  const files = filesFromDiff('--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n---- section\n+kept');
  return files.length === 1 && files[0].path === 'doc.md' && files[0].status === 'M';
})());

// ── buildReality: bashEvents → commands, files from diff, passthrough ──
{
  const r = buildReality({
    diff: '--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-x\n+y',
    bashEvents: [
      { cmd: 'npm test', is_error: false },
      { cmd: 'npm run flaky', is_error: true },
      { cmd: 'sleep 99', background: true, is_error: false },   // background → no final status → dropped
    ],
    symbolsByFile: { 'a.mjs': ['y'] },
    excluded: (p) => p === 'skip',
  });
  ok('buildReality: files parsed from diff', r.files.length === 1 && r.files[0].path === 'a.mjs');
  ok('buildReality: green run → ok:true', r.commands.some(c => c.cmd === 'npm test' && c.ok === true));
  ok('buildReality: red run → ok:false', r.commands.some(c => c.cmd === 'npm run flaky' && c.ok === false));
  ok('buildReality: background command dropped (no final status)', !r.commands.some(c => c.cmd === 'sleep 99'));
  ok('buildReality: symbolsByFile + excluded passed through', r.symbolsByFile['a.mjs'][0] === 'y' && r.excluded('skip'));
}

// ── contractFindings: the engine-shaped ({cls,sev,msg}) entry the Stop hook calls ──
ok('contractFindings: no block → single NC finding', (() => {
  const f = contractFindings('just prose, no fence', {});
  return f.length === 1 && f[0].cls === 'NC' && f[0].sev === 'warn' && f[0].msg.includes(FENCE_TAG);
})());
ok('contractFindings: malformed JSON → NC', contractFindings(block('{ bad json }'), {}).some(f => f.cls === 'NC'));
ok('contractFindings: valid contract, clean reality → no findings', contractFindings(block(good()), { files: [{ status: 'A', path: 'src/auth.mjs' }], commands: [] }).length === 0);
{
  // the pincer through the engine seam: invented file → CA(block), undeclared file → UC(warn)
  const msg = block(JSON.stringify({ v: 1, task: 't', status: 'complete', claims: [{ t: 'created', file: 'promised.mjs' }] }));
  const f = contractFindings(msg, { files: [{ status: 'A', path: 'promised.mjs' }, { status: 'M', path: 'surprise.mjs' }], commands: [] });
  ok('contractFindings: shape is engine-native {cls,sev,msg}', f.every(x => x.cls && x.sev && x.msg));
  ok('contractFindings: undeclared surprise.mjs → UC', f.some(x => x.cls === 'UC' && x.msg.includes('surprise.mjs')));
}

// ── addedSymbolsByFile: the per-file symbol lexer that feeds buildReality().symbolsByFile ──
{
  const { addedSymbolsByFile } = await import('./symbol-integrity.mjs');
  const map = addedSymbolsByFile('--- /dev/null\n+++ b/a.mjs\n+export function foo(){}\n+const bar = 1\n+++ b/b.mjs\n+export function baz(){}');
  ok('addedSymbolsByFile: binds symbols to the file that added them', (map['a.mjs'] || []).includes('foo') && (map['b.mjs'] || []).includes('baz'));
  ok('addedSymbolsByFile: does not leak a symbol across files', !(map['b.mjs'] || []).includes('foo'));
}

console.log(`\n${pass} checks passed.`);
