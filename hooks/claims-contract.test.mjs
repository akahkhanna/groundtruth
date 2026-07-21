#!/usr/bin/env node
/**
 * claims-contract.test.mjs — self-check for the Groundtruth v2 claims contract (run: `node claims-contract.test.mjs`).
 * Fixture corpus: valid blocks (every claim type), malformed JSON, each schema rule, and the fence parser
 * (missing / multiple / CRLF / prose-wrapped / extra backticks). assert-based, no deps — a thrown assert
 * fails loud with the label.
 */
import assert from 'node:assert';
import {
  analyze, parseContract, validateContract, findClaimsBlock, isValidPath,
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

console.log(`\n${pass} checks passed.`);
