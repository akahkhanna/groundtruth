#!/usr/bin/env node
/**
 * symbol-integrity.mjs — Groundtruth Class 6: a DANGLING REFERENCE under a preservation claim.
 *
 * The pain this exists for: an agent refactors (3 classes → 1, or 1 → many), copies code around,
 * and claims "everything preserved / no behaviour change" — but a function/method that existed BEFORE
 * is silently GONE after, and nothing catches it until it breaks at runtime. It is the honesty sibling
 * of Class 3 (silent no-op): a false "preserved". Deterministic — no LLM.
 *
 * We do NOT try to detect drops/renames/merges — that needs intent/semantics. We detect the observable
 * CONSEQUENCE: a call that no longer resolves, in a turn that claimed nothing changed. That single
 * reframe makes rename / casing-change / merge / authorised-deletion all fall out correctly:
 *   - renamed & callers updated → nothing dangles → SILENT (correct).
 *   - renamed but a caller was missed → that call dangles → FIRES on the real broken call (correct).
 *   - merged two→one, callers rewired → silent; a caller forgotten → fires on it.
 *   - user ASKED for the removal → irrelevant: a clean removal has no dangling call (silent); one that
 *     leaves a dangling caller fires regardless of who asked (it is a real broken build). This is why
 *     there is no "disclosure/asked-for" suppressor — it would HIDE a real dangling caller.
 *
 * The rule (all deterministic, one `git grep`):
 *   preservation/refactor/rename/merge claim  ·  a def the diff REMOVED  ·  defined NOWHERE in the tree
 *   ·  still CALLED somewhere (a bare `foo(` or a self `this.foo()`)  →  warn, quoting the dead callsite.
 *
 * Call classification is receiver-gated ("Option R") — the FP-killer. A call counts as dangling only if:
 *   Arm A — bare `foo(` (not `x.foo(`), and `foo` is not a stdlib global (fetch/print/len/…).
 *   Arm B — self `this.foo(` / `super.foo(` / `self.foo(`.
 * Every other receiver — `order.foo(`, `pkg.foo(` — ABSTAINS: its resolution runs through the receiver's
 * TYPE, which grep can't see, so counting it was always a guess (that guess IS the `stream.flush()` /
 * `cache.get()` collision FP). Same abstain-over-guess posture as Class 4 on package imports.
 *
 * Accepted ceilings (documented, not silent): lossy merge / gutted body (name kept, logic dropped →
 * semantic; partial cover — a stub body trips Class 2); public-API drop with NO in-repo caller (silent —
 * precision over recall); dynamic dispatch `obj[name]()` / value refs `arr.map(fn)` / parenless getters
 * (call invisible → miss); cross-object instance calls & all Go method calls (Arm-R abstains); overload /
 * same name on another class (name-level presence suppresses); C/C++ abstain (prototype≠def on one line).
 */
import { blankStrings, splitCodeComment, extOf, excludedScanPath, TEST_FILE_RE } from './groundtruth.mjs';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Control-flow / keyword words shaped like `word ( … ) {` or `word(` — never a real def/call name.
const KW = new Set(('if for while switch catch do else try finally return new delete typeof void in of case ' +
  'default throw with await yield function class constructor super this import export from as declare ' +
  'it its describe test expect context suite setup teardown before after beforeeach aftereach beforeall afterall ' +
  'when then given and or not match loop unless begin end lock using foreach synchronized').split(/\s+/));

// Bare-call names that resolve to a language/global builtin even when defined nowhere in-tree — so a bare
// `foo(` to one of these is NOT dangling (Arm A guard). Bounded, stdlib-only (NOT a library blocklist);
// combined across families (a name that is a builtin anywhere is a weak dangling-target — err to silence).
const GLOBALS = new Set(('setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame ' +
  'fetch alert confirm prompt print require parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent ' +
  'encodeURI decodeURI structuredClone queueMicrotask btoa atob eval super ' +
  'len range open input enumerate zip map filter sorted reversed sum min max abs round list dict set tuple frozenset ' +
  'str int float bool bytes bytearray type isinstance issubclass getattr setattr hasattr delattr id hash repr format ' +
  'iter next vars dir callable any all ord chr hex oct bin ' +
  'make new cap append copy delete close panic recover println complex real imag clear').split(/\s+/));

// Per-family definition regexes. Group 1 = the defined name. Applied to a code slice with strings blanked,
// so a def keyword inside a comment / string never counts (the comment-launder / string-launder dodges).
const DEF_RES = {
  js: [
    // function decl:  export default async function* foo(
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]{2,})/,
    // const/let/var = function | arrow | HOF-wrapped(ident(…)):  const foo = memoize(function(){})
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]{2,})\s*=\s*(?:async\s*)?(?:function\b|\([^)('"`]*\)\s*(?::[^={]+)?=>|[A-Za-z_$][\w$]*\s*=>|[A-Za-z_$][\w$]*\s*\()/,
    // class-field arrow (the classic `this`-binding refactor target):  foo = (a) => {   |  #foo = async () =>
    /^\s*(?:(?:static|readonly|public|private|protected)\s+|#)*([A-Za-z_$][\w$]{2,})\s*=\s*(?:async\s*)?(?:function\b|\([^)('"`]*\)\s*(?::[^={]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    // method shorthand:  static async foo(a, b: T = 1) {   — clean params only (no quotes/parens/arrows,
    // and a real `(params) {` header), which excludes a removed callback-call line from registering as a def.
    /^\s*(?:(?:static|async|get|set|public|private|protected|readonly|override|final|abstract)\s+|[*#]\s*)*([A-Za-z_$][\w$]{2,})\s*(?:<[^>{(]*>)?\s*\([A-Za-z0-9_$,\s:?=<>.\[\]|&]*\)\s*(?::[^={;]+)?\{/,
    // object-property function:  foo: (a) => {   |  foo: async function(   — value must be a function/arrow
    /^\s*([A-Za-z_$][\w$]{2,})\s*:\s*(?:async\s*)?(?:function\b|\([^)('"`]*\)\s*(?::[^={]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  ],
  py:  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w{2,})/],
  go:  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w{2,})/],
  rs:  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w{2,})/],
  rb:  [/^\s*def\s+(?:self\.)?([A-Za-z_]\w{1,}[?!=]?)/],
  jvm: [
    /\bfun\s+([A-Za-z_]\w{2,})/,                  // kotlin
    /\bfunc\s+([A-Za-z_]\w{2,})/,                 // swift
    /\bdef\s+([A-Za-z_]\w{2,})/,                  // scala
    /\bfunction\s+([A-Za-z_]\w{2,})/,             // php
    // java / c# method — REQUIRES an access/other modifier, so `return foo()` / `new Foo()` can't match.
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|sealed|async)\s+)+[\w<>\[\],.?]+\s+([a-zA-Z_]\w{2,})\s*\(/,
  ],
};
function familyOf(ext) {
  if (/^(?:js|ts|mjs|cjs|mts|cts|jsx|tsx|vue|svelte)$/.test(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rs';
  if (ext === 'rb') return 'rb';
  if (/^(?:java|cs|kt|kts|scala|swift|php)$/.test(ext)) return 'jvm';
  return null;   // c/cc/cpp/h + everything else → abstain
}

// Grep hits from generated / vendored / minified output or a type-declaration file are never trustworthy
// evidence (a stale bundle keeps old calls; a `.d.ts` carries signatures, not calls). excludedScanPath
// does NOT cover these — verified.
const NOISE_PATH = /(^|\/)(?:dist|build|out|vendor|third_party|coverage|target|\.next|node_modules)\//i;
const isMinOrDts = (p) => /\.min\.\w+$/i.test(p) || /\.d\.ts$/i.test(p);

/** Names DEFINED on one code line (strings blanked, keywords dropped). */
function defsOn(code, fam) {
  const c = blankStrings(code);
  const out = [];
  for (const re of DEF_RES[fam]) {
    const m = c.match(re);
    if (m && m[1] && !KW.has(m[1].toLowerCase())) out.push(m[1]);
  }
  return out;
}

/**
 * Walk a unified diff → { removed: Map<name,{file}>, added: Set<name> }. Removed defs are keyed off the
 * OLD-file header `--- a/…` (NOT `+++ b/…`), because the primary case — "3 classes → 1" — DELETES files,
 * whose new-side header is `+++ /dev/null` and whose removed lines are otherwise invisible. The added set
 * only SUPPRESSES (a move within the change), so it excludes only throwaway sandboxes (a def parked in
 * `tmp/` is not a real home — the move-to-scratch dodge); test files stay admissible. Block-comment state
 * is threaded per file across its own removed / added lines (best-effort on a diff, same limit as Class 2).
 * Exported for a direct unit test.
 */
export function collectDefs(diff) {
  const removed = new Map();
  const added = new Set();
  let oldFile = '', newFile = '';
  const rmState = {}, addState = {};
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('--- ')) { const m = line.match(/^--- a\/(.+)$/); oldFile = m ? m[1] : ''; continue; }
    if (line.startsWith('+++ ')) { const m = line.match(/^\+\+\+ b\/(.+)$/); newFile = m ? m[1] : ''; continue; }
    const c = line[0];
    if (c === '-') {
      if (!oldFile || excludedScanPath(oldFile) || TEST_FILE_RE.test(oldFile)) continue;
      const fam = familyOf(extOf(oldFile));
      if (!fam) continue;
      const st = (rmState[oldFile] ||= { block: false, fence: false });
      const { code } = splitCodeComment(line.slice(1), extOf(oldFile), st);
      for (const name of defsOn(code, fam)) if (!removed.has(name)) removed.set(name, { file: oldFile });
    } else if (c === '+') {
      if (!newFile || excludedScanPath(newFile)) continue;
      const fam = familyOf(extOf(newFile));
      if (!fam) continue;
      const st = (addState[newFile] ||= { block: false, fence: false });
      const { code } = splitCodeComment(line.slice(1), extOf(newFile), st);
      for (const name of defsOn(code, fam)) added.add(name);
    }
  }
  return { removed, added };
}

/**
 * v2 claims-contract support: symbols ADDED in the diff, keyed by the file that added them →
 *   { [file]: string[] }
 * collectDefs' `added` is a diff-GLOBAL Set (all it needs to prove a removed def re-appears); the contract
 * verifier instead asks "does file X actually define the symbol its `created`/`modified` claim named?", so
 * it needs the per-file binding. Same `+`-side walk as collectDefs, keyed by newFile. A file whose language
 * has no lexer family is simply absent from the map — the verifier ABSTAINS on it (never a false CA).
 */
export function addedSymbolsByFile(diff) {
  const byFile = {};
  let newFile = '';
  const addState = {};
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) { const m = line.match(/^\+\+\+ b\/(.+)$/); newFile = m ? m[1] : ''; continue; }
    if (line[0] !== '+') continue;
    if (!newFile || excludedScanPath(newFile)) continue;
    const fam = familyOf(extOf(newFile));
    if (!fam) continue;
    const st = (addState[newFile] ||= { block: false, fence: false });
    const { code } = splitCodeComment(line.slice(1), extOf(newFile), st);
    for (const name of defsOn(code, fam)) (byFile[newFile] ||= []).push(name);
  }
  for (const f of Object.keys(byFile)) byFile[f] = [...new Set(byFile[f])];
  return byFile;
}

/**
 * Classify `git grep -n` output (path:line:content) for the candidate names →
 *   { defined: Set<name>, callsites: Map<name,{loc,text}> }
 * `defined` = the name is a DEFINITION or a suppressing IMPORT somewhere (→ not dropped). `callsites` =
 * a dangling bare/self call (→ the reference the removal broke). Fresh comment-state per hit (grep returns
 * only matching lines, so cross-line block state can't be threaded).
 */
function classifyHits(grepOut, wantNames) {
  const want = new Set(wantNames);
  const defined = new Set();
  const callsites = new Map();
  for (const hit of String(grepOut).split('\n')) {
    const m = hit.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, path, lineNo, content] = m;
    if (excludedScanPath(path) || NOISE_PATH.test(path)) continue;
    const fam = familyOf(extOf(path));
    if (!fam) continue;
    const { code } = splitCodeComment(content, extOf(path), { block: false, fence: false });
    if (/^\s*\*\s/.test(code)) continue;                 // block-comment continuation (JSDoc) — not code
    const blanked = blankStrings(code);

    // DEFINITION elsewhere → the symbol survives (moved / overload / other class).
    for (const name of defsOn(code, fam)) if (want.has(name)) defined.add(name);

    // IMPORT-binding presence → re-imported where used = preserved. But NOT `import type` (a type dodge,
    // not a value) and NOT a RELATIVE re-export (`export { x } from './y'` — a stale one is itself broken,
    // so it must not hide a dangling caller). A non-relative/package import legitimately means the def
    // lives out of tree (monorepo extraction / node_modules) → suppress.
    if (/(^|\s)(?:import|require)\b|\bfrom\s+['"]/.test(code) && !/\bimport\s+type\b|\{\s*type\s/.test(code)) {
      const spec = (code.match(/from\s*['"]([^'"]+)['"]/) || code.match(/require\s*\(\s*['"]([^'"]+)['"]/) || [])[1];
      if (!(spec && /^\.\.?\//.test(spec)))              // relative specifier → neutral (neither suppress nor evidence)
        for (const name of want) if (new RegExp(`\\b${escapeRe(name)}\\b`).test(blanked)) defined.add(name);
    }

    // CALL evidence (Arm R). Skip .d.ts / .min — they carry signatures, not calls.
    if (!isMinOrDts(path)) for (const name of want) {
      if (callsites.has(name)) continue;
      const n = escapeRe(name);
      const self = new RegExp(`(?:this|self|super)\\s*[?!]?\\.\\s*${n}\\s*(?:\\?\\.)?\\s*\\(`); // Arm B (incl. this?.foo?.() optional call)
      const bare = new RegExp(`(?<!(?:function|func|fun|def|fn)\\s)(?<![\\w$.])${n}\\s*\\(`); // Arm A
      if (self.test(blanked) || (!GLOBALS.has(name) && bare.test(blanked)))
        callsites.set(name, { loc: `${path}:${lineNo}`, text: code.trim().slice(0, 60) });
    }
  }
  return { defined, callsites };
}

// The claim (or an ask) asserts behaviour-preservation. Bare "refactored"/"consolidated"/"merged" DOES
// gate — a refactor MEANS behaviour-preserving. `merge` is guarded against git-branch language so
// "merged staging into master" does not open the gate. `inline` is intentionally OUT (inlining announces
// its own removal). A wider gate is nearly free: gate-open with zero candidates is silent.
const PRESERVE_RE = new RegExp(
  '\\b(?:refactor\\w*|consolidat\\w+|deduplicat\\w+|unif(?:y|ied|ies)|extract\\w+|simplif\\w+|' +
  'split\\w*|decompos\\w+|modulariz\\w+|restructur\\w+|mov(?:e|ed|ing)|' +
  'pure\\s+refactor|drop-in\\s+replacement|feature[-\\s]parity|1:1|no\\s+regressions?|' +
  'behaviou?r[\\s-]*(?:preserv\\w+|unchanged|identical|equivalent)|no\\s+(?:behaviou?ral?|functional)\\s+changes?|' +
  'functionally\\s+(?:identical|equivalent|the\\s+same)|work(?:s|ing)?\\s+(?:exactly\\s+)?(?:the\\s+same|as\\s+before)|' +
  'nothing\\s+(?:changed|removed|lost)|' +
  '(?:everything|all\\s+(?:the\\s+)?(?:methods?|functions?|logic|functionality|behaviou?r))\\s+(?:is\\s+|are\\s+|was\\s+|were\\s+)?' +
  '(?:preserv\\w+|kept|intact|unchanged|retained|carried\\s+over|the\\s+same)|same\\s+behaviou?r|' +
  'renam\\w+|' +
  'merg(?:e|ed|ing)(?!\\s+(?:\\w+\\s+){0,3}(?:branch|pr|pull|main|master|staging|origin|remote|conflict|upstream)))\\b',
  'i');
function gateOpens(claim, asks) {
  return PRESERVE_RE.test(claim) || (asks || []).some(a => PRESERVE_RE.test(a));
}

/**
 * The check. Pure except for the injected `grepTree(names) -> git-grep stdout` (which `main()` wires to
 * `git grep` and tests stub). grepTree MUST throw on a real git error and return '' on a clean no-match —
 * so "grep unavailable" fails OPEN (emit nothing) while "grep ran, found nothing" proceeds. Returns [] or
 * exactly one aggregated `{ cls: 6, sev: 'warn', msg }`. With no grepTree there is no call evidence, so it
 * is silent by construction (never fires on a Layer-1 survivor alone).
 */
export function checkDroppedSymbols({ claim = '', diff = '', asks = [], grepTree = null, requireClaim = true } = {}) {
  // The claim gate scopes the Stop-hook run to refactor turns. At COMMIT time (pre-commit hook) there is
  // no agent claim — and none is needed: a dangling reference is a broken build regardless of intent. So
  // `requireClaim: false` runs it gate-free, which is what covers code PASTED in from a chat (no Stop hook
  // ever fired) — the pre-commit hook is the choke point all code flows through.
  if (requireClaim && !gateOpens(claim, asks)) return [];
  const { removed, added } = collectDefs(diff);
  const survivors = [...removed.entries()].filter(([name]) => !added.has(name));   // Layer 1 (free): re-added?
  if (!survivors.length || !grepTree) return [];

  let out;
  try { out = grepTree(survivors.slice(0, 100).map(([n]) => n)); }
  catch { return []; }                                                     // grep unavailable → fail open
  const { defined, callsites } = classifyHits(out, survivors.map(([n]) => n));

  // Fire: defined NOWHERE (not moved / overloaded / re-imported) AND still has a dangling bare/self call.
  const firing = survivors.filter(([name]) => !defined.has(name) && callsites.has(name));
  if (!firing.length) return [];

  const frag = (claim.match(PRESERVE_RE) || asks.map(a => a.match(PRESERVE_RE)).find(Boolean) || [''])[0].trim().slice(0, 40);
  const head = firing.slice(0, 3).map(([n, v]) => {
    const cs = callsites.get(n);
    return `${n} (removed from ${v.file}) — still called at ${cs.loc}`;
  }).join('; ');
  const rest = firing.slice(3).map(([n]) => n);
  const more = rest.length ? ` [+${rest.length} more: ${rest.slice(0, 5).join(', ')}${rest.length > 5 ? ', …' : ''}]` : '';
  const lead = frag ? `claimed behaviour-preserving ("${frag}"), but ` : '';   // gate-free (commit) run has no claim
  return [{ cls: 6, sev: 'warn',
    msg: `${lead}${head} — defined nowhere in the tree after the change (a dangling reference: moved nowhere, still called)${more}` }];
}
