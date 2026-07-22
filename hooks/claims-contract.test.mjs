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
  filesFromDiff, buildReality, contractFindings, openDeferrals,
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
  // C-8 (Fable adv FP-9): the last block that VALIDATES wins — a real contract followed by an INVALID quoted
  // example (a schema-help snippet, an echoed handback) must not be superseded into NC.
  const realThenExample = block(good({ task: 'REAL' })) + '\n\nFor reference, the format is:\n\n' + block('{ "v": 1, "task": "<desc>", "status": "<complete|partial|blocked>", "claims": [] }');
  const re = analyze(realThenExample);
  ok('multiple blocks: a valid contract + a trailing INVALID example → the valid one wins (not NC)', re.ok && re.contract.task === 'REAL');
  // but two VALID blocks still resolve to the last (authoritative end-of-turn declaration)
  ok('multiple blocks: two valid blocks still → last wins', analyze(two).contract.task === 'SECOND');
  // and if the ONLY block is invalid, it is still NC (no false rescue)
  ok('single invalid block → still NC', !analyze(block('{ "v": 1, "task": "x", "status": "nope", "claims": [] }')).ok);
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
// adversarial: a rename decomposed as delete-source + create-target is TRUE — not a block-tier "absent" CA
ok('a rename declared as `deleted <source>` is clean (rename removes it at that path)', verify(contract([{ t: 'deleted', file: 'old.mjs' }]), { files: [{ status: 'R', from: 'old.mjs', path: 'new.mjs' }] }).ok);
ok('a rename declared as `created <target>` is clean (rename creates it at that path)', verify(contract([{ t: 'created', file: 'new.mjs' }]), { files: [{ status: 'R', from: 'old.mjs', path: 'new.mjs' }] }).ok);
ok('but a genuinely absent `deleted` claim STILL fires (rename acceptance is narrow)', has(verify(contract([{ t: 'deleted', file: 'ghost.mjs' }]), { files: [] }), 'CA', 'absent'));

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
ok('filesFromDiff: a bare +++ b/ fragment is IGNORED (ledger creates come from buildReality, not diff text)', filesFromDiff('+++ b/created.mjs\n+line').length === 0);
ok('filesFromDiff: a content line starting with dashes inside a hunk is NOT a file header', (() => {
  // `---- section` is a REMOVED markdown rule inside the hunk (prefix `-` + `--- section`), not a header.
  const files = filesFromDiff('diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n---- section\n+kept');
  return files.length === 1 && files[0].path === 'doc.md' && files[0].status === 'M';
})());
ok('filesFromDiff: an in-hunk content line `++ b/X` (→ +++ b/X) cannot mint a phantom file (round 3, Issue 2)', (() => {
  // real git diff: an added line whose content is `++ b/ghost.js` renders in the hunk as `+++ b/ghost.js`.
  const files = filesFromDiff('diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1,0 +1,2 @@\n++ b/ghost.js\n+real');
  return files.length === 1 && files[0].path === 'notes.md' && !files.some(f => f.path === 'ghost.js');
})());
ok('filesFromDiff: empty new file (no hunk headers) → A', filesFromDiff('diff --git a/pkg/__init__.py b/pkg/__init__.py\nnew file mode 100644\nindex 0000000..e69de29').find(f => f.path === 'pkg/__init__.py')?.status === 'A');
ok('filesFromDiff: binary modify (no ---/+++ ) → M', filesFromDiff('diff --git a/logo.png b/logo.png\nindex a1..b2 100644\nBinary files a/logo.png and b/logo.png differ').find(f => f.path === 'logo.png')?.status === 'M');
ok('filesFromDiff: quoted non-ASCII path is decoded', filesFromDiff('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\nnew file mode 100644\n--- /dev/null\n+++ "b/caf\\303\\251.js"\n+x').some(f => f.path === 'café.js'));
ok('filesFromDiff: unquoted path with spaces (empty new file) parses whole path', filesFromDiff('diff --git a/my file.js b/my file.js\nnew file mode 100644\nindex 0..e').some(f => f.path === 'my file.js'));
// The mixed-session seam (tracked edit + untracked create) — the untracked create now comes from the
// AUTHORITATIVE ledger via buildReality, not from parsing a fragment out of the diff text.
{
  const mixed = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-a\n+b';
  const r = buildReality({ diff: mixed, cwd: '/abs/repo', authored: ['/abs/repo/app.js', '/abs/repo/helper.js'] });
  ok('buildReality: mixed session — tracked edit (M from diff) + untracked create (A from ledger)', r.files.some(f => f.path === 'app.js' && f.status === 'M') && r.files.some(f => f.path === 'helper.js' && f.status === 'A'));
  ok('buildReality: a ledger create is NOT duplicated when it is already a tracked git change', buildReality({ diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b', cwd: '/r', authored: ['/r/x.js'] }).files.filter(f => f.path === 'x.js').length === 1);
}

// ── buildReality: bashEvents → commands, files from diff, passthrough ──
{
  const r = buildReality({
    diff: 'diff --git a/a.mjs b/a.mjs\n--- a/a.mjs\n+++ b/a.mjs\n@@ -1 +1 @@\n-x\n+y',
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
  ok('buildReality: background command is CARRIED with a flag (not dropped → no false "no such command ran")', r.commands.some(c => c.cmd === 'sleep 99' && c.background === true));
  ok('buildReality: symbolsByFile + excluded passed through', r.symbolsByFile['a.mjs'][0] === 'y' && r.excluded('skip'));
}
// buildReality — the FP fixes (Fable findings 1/3/7)
ok('buildReality: an absolute authored create is relativized against cwd and added as A (finding 1)', (() => {
  const r = buildReality({ diff: '', cwd: '/home/u/repo', authored: ['/home/u/repo/src/new.mjs'] });
  return r.files.some(f => f.path === 'src/new.mjs' && f.status === 'A');
})());
ok('buildReality: bashEvents undefined → commands undefined (abstain, not empty) (finding 3)', buildReality({ diff: '' }).commands === undefined);
ok('buildReality: unpaired run (is_error null) → ok null, tri-state (finding 3)', buildReality({ diff: '', bashEvents: [{ cmd: 'npm test', is_error: null }] }).commands[0].ok === null);
ok('buildReality: authored set relativized for UC scope (finding 7)', buildReality({ diff: '', cwd: '/r', authored: ['/r/a.mjs', 'b.mjs'] }).authored.has('a.mjs'));
// C-8 (Fable adv FP-5/FN-5/FP-8): the synthetic `A` is DISK-PRESENCE gated on the untracked set, not the ledger.
ok('buildReality: with untracked given, an edit-then-REVERT (authored, NOT untracked) mints NO phantom A', (() => {
  const r = buildReality({ diff: '', cwd: '/r', authored: ['/r/src/app.js'], untracked: [] });
  return !r.files.some(f => f.path === 'src/app.js');   // net-zero diff + not untracked → nothing changed
})());
ok('buildReality: a Write-then-rm file (authored, NOT untracked) mints NO A (created claim will CA)', !buildReality({ diff: '', cwd: '/r', authored: ['/r/ghost.md'], untracked: [] }).files.some(f => f.path === 'ghost.md'));
ok('buildReality: a heredoc create (untracked-present, NOT in ledger) IS surfaced as A', buildReality({ diff: '', cwd: '/r', authored: [], untracked: ['tools/gen.py'] }).files.some(f => f.path === 'tools/gen.py' && f.status === 'A'));
ok('buildReality: with untracked UNKNOWN (no-git fallback) the ledger mint still applies', buildReality({ diff: '', cwd: '/r', authored: ['/r/src/new.mjs'] }).files.some(f => f.path === 'src/new.mjs' && f.status === 'A'));
ok('verify: honest no_change after edit-then-revert (untracked:[]) → clean (FP-5)', verify(contract([{ t: 'no_change' }]), buildReality({ diff: '', cwd: '/r', authored: ['/r/src/app.js'], untracked: [] })).ok);
ok('verify: Write-then-rm `created ghost.md` (untracked:[]) → CA, not blessed (FN-5)', has(verify(contract([{ t: 'created', file: 'ghost.md' }]), buildReality({ diff: '', cwd: '/r', authored: ['/r/ghost.md'], untracked: [] })), 'CA', 'absent from the diff'));
ok('verify: honest heredoc `created tools/gen.py` (untracked-present) → clean (FP-8)', verify(contract([{ t: 'created', file: 'tools/gen.py' }]), buildReality({ diff: '', cwd: '/r', authored: [], untracked: ['tools/gen.py'] })).ok);
ok('verify: an UNDECLARED authored untracked create still fires UC (no regression)', has(verify(contract([{ t: 'no_change' }]), buildReality({ diff: '', cwd: '/r', authored: ['/r/src/sneaky.js'], untracked: ['src/sneaky.js'] })), 'UC', 'undeclared change'));
// C-9 (Fable review D1): untracked === null (git status failed / no-git workspace) ⇒ LEDGER fallback, not an
// empty untracked set — else every honest Write-created `created` claim blocks on the fail-open path.
ok('buildReality: untracked=null (git unknown) falls back to the ledger mint (honest created verifies)', buildReality({ diff: '', cwd: '/r', authored: ['/r/new.mjs'], untracked: null }).files.some(f => f.path === 'new.mjs' && f.status === 'A'));
ok('verify: honest `created` in a no-git workspace (untracked:null) → clean, not a block', verify(contract([{ t: 'created', file: 'new.mjs' }]), buildReality({ diff: '', cwd: '/r', authored: ['/r/new.mjs'], untracked: null })).ok);
// C-9 (Fable review C1): the swallow sensor tests only the TAIL from `want` — a forcer on an earlier setup cmd is not the test's.
ok('sensor swallowed-exit ABSTAINS when the forcer is on an EARLIER setup cmd (`mkdir || true; npm test`)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'mkdir -p build || true; npm test', ok: true }] }).ok);
ok('sensor swallowed-exit STILL warns when the forcer is on the test itself (`… ; npm test || true`)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'echo go; npm test || true', ok: true }] }), 'CA', 'force-succeeded'));
// C-9 (Fable review C2): a claim on an EXCLUDED path abstains in the CA pass too (consistency with UC/NC).
ok('verify: a `created` claim on an EXCLUDED path abstains (no CA block)', verify(contract([{ t: 'created', file: 'scratch/repro.js' }]), { files: [], excluded: (p) => p.startsWith('scratch/') }).ok);
// C-9 (Fable review D3): `#npm test` (no space) is a comment → does NOT bless a never-run tests_pass.
ok('verify: `#npm test` (no space, a comment) does NOT bless tests_pass → CA', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: '#npm test', ok: true }] }), 'CA', 'no such command ran'));
// verify — the FP fixes
ok('verify: truthful tests_pass with NO transcript (commands undefined) → abstain, never CA', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [] }).ok);
ok('verify: tests_pass matched only by an unpaired run → abstain (not a false "exited non-zero")', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: null }] }).ok);
ok('verify: stale green — green(seq1) then red re-run(seq2) → CA (last run wins, no laundering)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 1 }, { cmd: 'npm test', ok: false, seq: 2 }] }), 'CA', 'last matching run'));
ok('verify: green re-run after edits (seq2 green) → clean', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: false, seq: 1 }, { cmd: 'npm test', ok: true, seq: 2 }] }).ok);
ok('verify: a lookalike (echo "npm test") does NOT bless tests_pass → CA no-run', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'echo "npm test would pass"', ok: true }] }), 'CA', 'no such command ran'));
ok('verify: a REAL invocation inside a compound run (echo x && npm test) still matches (finding 5 residual)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'echo start && npm test', ok: true }] }).ok);
// round 3, Issue 1: the cmd MENTIONED inside a QUOTED arg must not count as a run (and its && must not split)
ok('verify: `grep "lint && npm test" f` (exit 1) does NOT false-CA an honest tests_pass (round 3, Issue 1)', (() => {
  const r = verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 1 }, { cmd: 'grep -c "lint && npm test" package.json', ok: false, seq: 2 }] });
  return r.ok;   // the real green npm test stands; the grep's quoted mention is masked out, not counted as a red run
})());
ok('verify: `echo "run npm test to verify"` alone does NOT bless tests_pass → CA no-run (round 3, Issue 1 mirror)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'echo "run npm test to verify"', ok: true }] }), 'CA', 'no such command ran'));
// C-8 (Fable adv FP-10): a tests_pass backed ONLY by a filtered SIDECHAIN (Task subagent) run → ABSTAIN, not block.
ok('verify: tests_pass with the matching run only in a sidechain → abstain (no CA block)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [], sidechainCmds: ['npm test'] }).ok);
ok('verify: sidechain abstain is cmd-specific — a DIFFERENT sidechain cmd does NOT rescue → CA', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [], sidechainCmds: ['npm run lint'] }), 'CA', 'no such command ran'));
ok('verify: genuinely nothing ran (no main, no sidechain) → CA block stands', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [], sidechainCmds: [] }), 'CA', 'no such command ran'));
// C-8 (Fable adv FN-2): a green whose exit was FORCE-succeeded (`|| true` / `; true`) is a manufactured pass → warn.
ok('sensor swallowed-exit: `npm test >/dev/null 2>&1 || true` (green) → warn (exit force-succeeded)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test >/dev/null 2>&1 || true', ok: true }] }), 'CA', 'force-succeeded'));
ok('sensor swallowed-exit: `npm test || :` → warn', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test || :', ok: true }] }), 'CA', 'force-succeeded'));
ok('sensor swallowed-exit ABSTAINS on a legit `|| <retry>` fallback (not a forcer)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test || npm run test:retry', ok: true }] }).ok);
ok('sensor swallowed-exit ABSTAINS on `|| exit 1` (propagates failure, not masked)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test || exit 1', ok: true }] }).ok);
ok('sensor swallowed-exit ABSTAINS on a plain redirect (exit still real)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test >/dev/null 2>&1', ok: true }] }).ok);
// round-3-verify: masking must NOT erase a REAL invocation inside quotes (that was a false CA block)
ok('verify: a claim cmd WITH quotes, run exactly, matches — `pytest -k "not slow"`', verify(contract([{ t: 'tests_pass', cmd: 'pytest -k "not slow"' }]), { files: [], commands: [{ cmd: 'pytest -k "not slow"', ok: true }] }).ok);
ok('verify: a quoted wrapper run — `bash -c "npm test"` (green) — matches an `npm test` claim', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'timeout 60 bash -c "npm test"', ok: true }] }).ok);
ok('verify: `sh -c \'npm test\'` (green) matches an npm test claim', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: "sh -c 'npm test'", ok: true }] }).ok);
// adversarial: a DIFFERENT command that merely has the claim as a token PREFIX must NOT bless (false green)
ok('verify: `npm test` claim is NOT blessed by running `npm test:watch` (token boundary, not substring)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test:watch', ok: true }] }), 'CA', 'no such command ran'));
ok('verify: `npm test` claim is NOT blessed by `npm testx` / `npm test-all`', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm testx', ok: true }, { cmd: 'npm test-all', ok: true }] }), 'CA', 'no such command ran'));
// ── Stage 3: the 4 ported tests_pass sensors (green-run refinements, warn/info, abstain when input absent) ──
ok('sensor only-weak: tests_pass cmd `tsc` (green) → warn (a type check is not a test run)', has(verify(contract([{ t: 'tests_pass', cmd: 'tsc' }]), { files: [], commands: [{ cmd: 'tsc', ok: true }] }), 'CA', 'syntax/type check'));
ok('sensor only-weak abstains: `tsc && npm test` has a real test → NOT weak', verify(contract([{ t: 'tests_pass', cmd: 'tsc && npm test' }]), { files: [], commands: [{ cmd: 'tsc && npm test', ok: true }] }).ok);
ok('sensor only-weak is tests_pass-only: build_pass `tsc` is honest, not flagged', verify(contract([{ t: 'build_pass', cmd: 'tsc' }]), { files: [], commands: [{ cmd: 'tsc', ok: true }] }).ok);
ok('sensor failure-substring: a green run whose OUTPUT says "3 failed" → warn', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'Tests: 3 failed, 5 passed' }] }), 'CA', 'reports failures despite a zero exit'));
ok('sensor failure-substring abstains: clean green output → no finding', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: '627 passing' }] }).ok);
// C-7 (redteam: "filename contains fail"): a green run whose output mentions `fail` as a benign token — a
// file/dir named `fail`, a test titled "should not fail", node:test "# fail 0" — must NOT trip the sensor.
ok('failure-substring abstains: passing file/dir literally named `fail`', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'PASS  fail/handler.test.js\nTests: 3 passed' }] }).ok);
ok('failure-substring abstains: passing test TITLED "should not fail"', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'ok 1 - should not fail\n# pass 1' }] }).ok);
ok('failure-substring abstains: node:test summary "# fail 0" on a passing run', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: '# tests 5\n# pass 5\n# fail 0' }] }).ok);
ok('failure-substring abstains: jest PASS line for a file named fail-safe', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'PASS src/fail-safe.test.js' }] }).ok);
// …but the UPPERCASE runner banners still fire, and pytest's FAILED (previously MISSED) now does too.
ok('failure-substring FIRES: jest uppercase FAIL banner', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'FAIL src/x.test.js' }] }), 'CA', 'reports failures despite a zero exit'));
ok('failure-substring FIRES: pytest FAILED banner (was a false-negative)', has(verify(contract([{ t: 'tests_pass', cmd: 'pytest' }]), { files: [], commands: [{ cmd: 'pytest', ok: true, text: 'FAILED tests/test_x.py::t - assert 1 == 2' }] }), 'CA', 'reports failures despite a zero exit'));
ok('failure-substring FIRES: node:test "# fail 1" (real failure, zero exit)', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: '# tests 5\n# pass 4\n# fail 1' }] }), 'CA', 'reports failures despite a zero exit'));
// C-8 (Fable adv FP-7): the banner is LINE-ANCHORED — a mid-line uppercase FAILED is prose/log noise, not a verdict.
ok('banner abstains: passing test TITLED "FAILED to connect (now fixed)" (mid-line)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'ok 1 - FAILED to connect (now fixed)\n# pass 1\n# fail 0' }] }).ok);
ok('banner abstains: benign app-log "request FAILED (expected)" mid-line in green output', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, text: 'running…\nrequest FAILED (expected, retrying)\nTests: 5 passed' }] }).ok);
ok('banner FIRES: go final "FAIL\\tpkg" at line start', has(verify(contract([{ t: 'tests_pass', cmd: 'go test ./...' }]), { files: [], commands: [{ cmd: 'go test ./...', ok: true, text: 'ok    pkg/a\nFAIL\tpkg/b\t0.2s' }] }), 'CA', 'reports failures despite a zero exit'));
ok('sensor stale-green: green(seq1) before last edit(seq2) → warn STALE', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 1 }], lastEditSeq: 2 }), 'CA', 'STALE'));
ok('sensor stale-green abstains: green(seq3) after last edit(seq2) → clean', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 3 }], lastEditSeq: 2 }).ok);
ok('sensor stale-green abstains: no lastEditSeq → no stale finding', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 1 }] }).ok);
ok('sensor stale-green abstains when a BACKGROUND run is in the mix (Fable final: its completion may postdate the edit)', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 2 }, { cmd: 'npm test', ok: null, background: true, seq: 6 }], lastEditSeq: 5 }).ok);
ok('sensor stale-green abstains when a later UNPAIRED run hides a possible fresh run', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: true, seq: 2 }, { cmd: 'npm test', ok: null, seq: 6 }], lastEditSeq: 5 }).ok);
ok('sensor filtered abstains when a background run is in the mix', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test -- --grep x', ok: true, seq: 1 }, { cmd: 'npm test', ok: null, background: true, seq: 2 }] }).ok);
ok('exit-CA abstains: a red run followed by a LATER unpaired run → outcome unknown, no false "exited non-zero"', verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test', ok: false, seq: 1 }, { cmd: 'npm test', ok: null, seq: 2 }] }).ok);
ok('sensor filtered: declared full `npm test` but every run was `--grep`-filtered → info', has(verify(contract([{ t: 'tests_pass', cmd: 'npm test' }]), { files: [], commands: [{ cmd: 'npm test -- --grep billing', ok: true }] }), 'CA', 'FILTERED'));
ok('sensor filtered abstains: an HONESTLY declared filtered cmd (`pytest -k billing`) is not flagged', verify(contract([{ t: 'tests_pass', cmd: 'pytest -k billing' }]), { files: [], commands: [{ cmd: 'pytest -k billing', ok: true }] }).ok);
ok('buildReality: an authored edit then `git mv` does not re-add the OLD path as a phantom A', (() => {
  const diff = 'diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js';
  const r = buildReality({ diff, cwd: '/r', authored: ['/r/old.js', '/r/new.js'] });
  return !r.files.some(f => f.status === 'A' && f.path === 'old.js') && r.files.some(f => f.status === 'R' && f.path === 'new.js');
})());
ok('verify: a background launch-ack (is_error:false) does NOT bless tests_pass → abstain (finding 3 residual)', buildReality({ diff: '', bashEvents: [{ cmd: 'npm test', is_error: false, background: true }] }).commands[0].ok === null);
ok('verify: UC scoped to agent-authored files — an undeclared HUMAN/dirty change is NOT flagged (finding 7)', verify(contract([{ t: 'modified', file: 'a.mjs' }]), { files: [{ status: 'M', path: 'a.mjs' }, { status: 'M', path: 'human.mjs' }], authored: new Set(['a.mjs']) }).ok);
ok('verify: UC still fires on an undeclared AGENT-authored change', has(verify(contract([{ t: 'modified', file: 'a.mjs' }]), { files: [{ status: 'M', path: 'a.mjs' }, { status: 'M', path: 'sneaky.mjs' }], authored: new Set(['a.mjs', 'sneaky.mjs']) }), 'UC', 'sneaky.mjs'));
ok('verify: a claim written ./src/x.mjs matches the git-relative src/x.mjs (finding 8, path literalism)', verify(contract([{ t: 'created', file: './src/x.mjs' }]), { files: [{ status: 'A', path: 'src/x.mjs' }], commands: [] }).ok);
ok('verify: modified + symbols does NOT false-CA on a pre-existing edited fn (finding 8)', verify(contract([{ t: 'modified', file: 'a.mjs', symbols: ['existingFn'] }]), { files: [{ status: 'M', path: 'a.mjs' }], symbolsByFile: { 'a.mjs': ['newlyAdded'] }, commands: [] }).ok);
ok('verify: created + symbols still CA when the symbol is not in the added code', has(verify(contract([{ t: 'created', file: 'a.mjs', symbols: ['ghost'] }]), { files: [{ status: 'A', path: 'a.mjs' }], symbolsByFile: { 'a.mjs': ['real'] }, commands: [] }), 'CA', 'ghost'));

// ── contractFindings: the engine-shaped ({cls,sev,msg}) entry the Stop hook calls ──
const authoredReality = (paths) => ({ files: paths.map(p => ({ status: 'A', path: p })), authored: new Set(paths) });
ok('contractFindings: no block but the agent AUTHORED changes → single NC finding', (() => {
  const f = contractFindings('just prose, no fence', authoredReality(['x.mjs']));
  return f.length === 1 && f[0].cls === 'NC' && f[0].sev === 'warn' && f[0].msg.includes(FENCE_TAG);
})());
ok('contractFindings: malformed JSON (with authored work) → NC', contractFindings(block('{ bad json }'), authoredReality(['x.mjs'])).some(f => f.cls === 'NC'));
ok('contractFindings: no block AND no authored change → ABSTAIN, no NC (kills the default-on nag storm)', contractFindings('just chatting, read-only turn', { files: [], authored: new Set() }).length === 0);
ok('contractFindings: valid contract, clean reality → no findings', contractFindings(block(good()), { files: [{ status: 'A', path: 'src/auth.mjs' }], commands: [] }).length === 0);
{
  // the pincer through the engine seam: invented file → CA(block), undeclared file → UC(warn)
  const msg = block(JSON.stringify({ v: 1, task: 't', status: 'complete', claims: [{ t: 'created', file: 'promised.mjs' }] }));
  const f = contractFindings(msg, { files: [{ status: 'A', path: 'promised.mjs' }, { status: 'M', path: 'surprise.mjs' }], commands: [] });
  ok('contractFindings: shape is engine-native {cls,sev,msg}', f.every(x => x.cls && x.sev && x.msg));
  ok('contractFindings: undeclared surprise.mjs → UC', f.some(x => x.cls === 'UC' && x.msg.includes('surprise.mjs')));
}
{
  // a declared deferral surfaces (the task-ledger replacement) — visible, warn-tier, never silent
  const msg = block(JSON.stringify({ v: 1, task: 't', status: 'partial', claims: [{ t: 'modified', file: 'a.mjs' }, { t: 'deferred', what: 'e2e tests', why: 'no staging env' }] }));
  const f = contractFindings(msg, { files: [{ status: 'M', path: 'a.mjs' }], commands: [] });
  ok('contractFindings: a declared deferral surfaces as a deferred finding', f.some(x => x.cls === 'deferred' && x.msg.includes('e2e tests')));
  // multi-turn: when the Stop hook supplies reality.openDeferrals (the session-wide OPEN set), contractFindings
  // surfaces THOSE — a deferral from an EARLIER turn shows even though THIS turn's contract didn't re-declare it.
  const g = contractFindings(block(JSON.stringify({ v: 1, task: 't', status: 'complete', claims: [{ t: 'modified', file: 'a.mjs' }] })),
    { files: [{ status: 'M', path: 'a.mjs' }], commands: [], openDeferrals: [{ what: 'e2e coverage', why: 'earlier turn' }] });
  ok('contractFindings: reality.openDeferrals surfaces prior-turn deferrals (multi-turn §6)', g.some(x => x.cls === 'deferred' && x.msg.includes('e2e coverage')));
}
// ── openDeferrals: reconstruct the still-open deferral set across the session's contracts (spec §6) ──
{
  const Ct = (task, ...claims) => ({ v: 1, task, status: 'complete', claims });
  const C = (...claims) => Ct('t', ...claims);
  const d = (what, why = 'r') => ({ t: 'deferred', what, why });
  const whats = (contracts) => openDeferrals(contracts).map(x => x.what);
  ok('openDeferrals: a deferral from turn 1 STAYS OPEN when turn 2 omits it (the persistence fix)',
    whats([C(d('add e2e coverage')), C({ t: 'modified', file: 'x.js' })]).join(',') === 'add e2e coverage');
  ok('openDeferrals: two turns of deferrals accumulate', openDeferrals([C(d('a thing')), C(d('another thing'))]).length === 2);
  ok('openDeferrals: dedupes by normalized `what`', openDeferrals([C(d('Fix The Retry')), C(d('fix the retry'))]).length === 1);
  // closes only on VERIFIED work covering the (distinctive) key, token-bounded:
  ok('openDeferrals: a CREATED file covering the multi-word `what` (token-bounded) CLOSES it',
    openDeferrals([C(d('add e2e coverage')), C({ t: 'created', file: 'tests/add-e2e-coverage.spec.ts' })]).length === 0);
  ok('openDeferrals: a run `cmd` covering the `what` CLOSES it',
    openDeferrals([C(d('run smoke suite')), C({ t: 'tests_pass', cmd: 'npm run smoke suite' })]).length === 0);
  ok('openDeferrals: unrelated later work does NOT false-close (bias to keep-open)',
    openDeferrals([C(d('add e2e coverage')), C({ t: 'modified', file: 'README.md' }, { t: 'tests_pass', cmd: 'npm test' })]).length === 1);
  ok('openDeferrals: re-declaring the same turn a matching claim appears KEEPS it open',
    openDeferrals([C(d('add e2e coverage'), { t: 'created', file: 'tests/add-e2e-coverage.spec.ts' })]).length === 1);
  // ── Fable PR #4 review: the four proven false-close leaks must NOT silently drop a set-aside ──
  // A/D — the agent-authored `task` is UNVERIFIED, so echoing the `what` in a later turn's task must NOT close.
  ok('openDeferrals (A): a task that echoes the `what` on a zero-work turn does NOT close',
    whats([Ct('add auth', { t: 'modified', file: 'src/auth.js' }, d('e2e coverage')), Ct('explain the e2e coverage plan', { t: 'no_change' })]).join(',') === 'e2e coverage');
  ok('openDeferrals (D): a blocked turn whose task equals the `what` does NOT close the original',
    whats([C(d('e2e coverage')), Ct('add e2e coverage', d('staging env access'))]).length === 2);
  // C — verify() abstains on `modified` symbols, so they are agent-assertable and must NOT close.
  ok('openDeferrals (C): a `modified` claim\'s symbols do NOT close (unverified channel)',
    whats([C(d('e2e coverage')), C({ t: 'modified', file: 'README.md', symbols: ['e2e coverage'] })]).join(',') === 'e2e coverage');
  // B — a terse, generic `what` must not be dropped by an incidental same-named path.
  ok('openDeferrals (B): terse `config` is NOT closed by an incidental src/config.js',
    whats([C(d('config')), C({ t: 'modified', file: 'src/config.js' })]).join(',') === 'config');
  ok('openDeferrals (B): terse `tests` is NOT closed by an incidental tests/other.fixture.json',
    whats([C(d('tests')), C({ t: 'created', file: 'tests/other.fixture.json' })]).join(',') === 'tests');
  ok('openDeferrals: empty / non-array input → []', openDeferrals(undefined).length === 0 && openDeferrals([]).length === 0);
}

// ── addedSymbolsByFile: the per-file symbol lexer that feeds buildReality().symbolsByFile ──
{
  const { addedSymbolsByFile } = await import('./symbol-integrity.mjs');
  const map = addedSymbolsByFile('--- /dev/null\n+++ b/a.mjs\n+export function foo(){}\n+const bar = 1\n+++ b/b.mjs\n+export function baz(){}');
  ok('addedSymbolsByFile: binds symbols to the file that added them', (map['a.mjs'] || []).includes('foo') && (map['b.mjs'] || []).includes('baz'));
  ok('addedSymbolsByFile: does not leak a symbol across files', !(map['b.mjs'] || []).includes('foo'));
  // C-8 (Fable adv FP-6): NON-function declarations register too (class/enum/interface/type/const), so a
  // `created` file's `symbols:["UserModel"]` claim isn't falsely flagged "not defined" when only its methods lex.
  const cm = addedSymbolsByFile('--- /dev/null\n+++ b/models.js\n+export class UserModel {\n+  save(d){ return d; }\n+}\n+export const CONFIG = { port: 3000 }');
  ok('addedSymbolsByFile: a class NAME registers (not only its methods)', (cm['models.js'] || []).includes('UserModel') && (cm['models.js'] || []).includes('save'));
  ok('addedSymbolsByFile: a const-object NAME registers', (cm['models.js'] || []).includes('CONFIG'));
  const py = addedSymbolsByFile('--- /dev/null\n+++ b/conf.py\n+class Config:\n+    DEBUG = True');
  ok('addedSymbolsByFile: python class registers', (py['conf.py'] || []).includes('Config'));
  const rs = addedSymbolsByFile('--- /dev/null\n+++ b/lib.rs\n+pub struct User { id: u32 }\n+pub enum State { On }');
  ok('addedSymbolsByFile: rust struct/enum register', (rs['lib.rs'] || []).includes('User') && (rs['lib.rs'] || []).includes('State'));
  // end-to-end: the honest class-symbol claim is CLEAN
  ok('verify: created class file, symbols:["UserModel"] → clean (FP-6)', verify(contract([{ t: 'created', file: 'models.js', symbols: ['UserModel'] }]), { files: [{ status: 'A', path: 'models.js' }], symbolsByFile: cm }).ok);
}

console.log(`\n${pass} checks passed.`);
