// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// the three line-matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and
// the all-or-nothing write. One command-line tool, no model calls, no network.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC.md section 3: its own break, its lines, whether it ends with a break. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

/** Line matching at three tiers (SPEC.md section 5). */
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** The first tier at which O occurs in lines at or after start, with every position there. */
function matchFrom(lines: string[], o: string[], start: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions: number[] = [];
    for (let i = start; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!tierEq(lines[i + j]!, o[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NPart {
  text: string;
  ctx: number | null;
}

/**
 * The lines N writes over O matched at pos. Context lines are the file's own matched lines;
 * at tier 2 every other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's (SPEC.md section 5).
 */
function buildN(fileLines: string[], pos: number, o: string[], n: NPart[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadingWs(fileLines[pos] ?? '');
    const p = leadingWs(o[0] ?? '');
    for (const part of n) {
      if (part.ctx !== null) {
        out.push(fileLines[pos + part.ctx]!);
        continue;
      }
      const t = part.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  } else {
    for (const part of n) {
      if (part.ctx !== null) out.push(fileLines[pos + part.ctx]!);
      else out.push(part.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The hunk's old start line, 1-based (A in `@@ -A[,B] +C[,D] @@`). */
  a: number;
  o: string[];
  n: NPart[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
  hasPlus: boolean;
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  return line.slice(4).split('\t')[0].trim();
}

function stripAB(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

/** Parse one hunk at lines[idx] (its `@@` header); returns it and the first line after its body. */
function parseHunk(lines: string[], idx: number): { hunk: Hunk; next: number } {
  const m = lines[idx]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = idx + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NPart[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
    }
    // A `\` line refers to the body line before it; only the two flags below read it.
  }
  // A `\` line says the line before it has no line break, so only a `\` that immediately
  // follows the hunk's last context-or-`+` line (or its last `+` line, for a created file)
  // keeps the result from ending with a line break; a `\` after a `-` line says nothing
  // about the new file.
  const kindOf = (l: string): string => (l === '' ? ' ' : l[0]!);
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    const kd = kindOf(body[k]!);
    if (lastCtxPlus < 0 && (kd === ' ' || kd === '+')) lastCtxPlus = k;
    if (lastPlus < 0 && kd === '+') lastPlus = k;
    if (lastCtxPlus >= 0 && lastPlus >= 0) break;
  }
  const noEolCtxPlus = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  const noEolPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  return { hunk: { a, o, n, noEolCtxPlus, noEolPlus, hasPlus: lastPlus >= 0 }, next: j };
}

function newUnifiedSection(): UnifiedSection {
  return {
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

function parseUnified(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  const flush = (): void => {
    if (sec !== null) {
      edits.push(unifiedSectionEdit(sec, strict, moves));
      sec = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (sec === null) {
      if (line.startsWith('diff --git ')) {
        const dg = parseDiffGit(line, i + 1);
        sec = newUnifiedSection();
        sec.diffOld = dg[0];
        sec.diffNew = dg[1];
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = newUnifiedSection();
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (sec.hunks.length === 0) {
      if (line.startsWith('diff --git ')) {
        flush();
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[i + 1]!);
          sec.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        sec.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flush();
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flush();
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  flush();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function resolveUnifiedPaths(sec: UnifiedSection): { old: string | null; nw: string | null } {
  let oldP: string | null = null;
  let newP: string | null = null;
  if (sec.hasPair) {
    oldP = sec.pairOld === '/dev/null' ? null : stripAB(sec.pairOld!);
    newP = sec.pairNew === '/dev/null' ? null : stripAB(sec.pairNew!);
  } else {
    oldP = sec.renameFrom !== null ? stripAB(sec.renameFrom) : sec.diffOld !== null ? stripAB(sec.diffOld) : null;
    newP = sec.renameTo !== null ? stripAB(sec.renameTo) : sec.diffNew !== null ? stripAB(sec.diffNew) : null;
    if (oldP === null && newP !== null) oldP = newP;
    if (newP === null && oldP !== null) newP = oldP;
  }
  return { old: oldP, nw: newP };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean, moves: Array<[string, string]>): Edit {
  const { old: oldP, nw: newP } = resolveUnifiedPaths(sec);
  let kind: 'create' | 'delete' | 'move' | 'change' | 'noop' = 'noop';
  if ((sec.newFile || oldP === null) && newP !== null) kind = 'create';
  else if ((sec.deletedFile || newP === null) && oldP !== null) kind = 'delete';
  else if (oldP !== null && newP !== null && oldP !== newP) kind = 'move';
  else if (oldP !== null && newP !== null) kind = 'change';
  return (tree) => {
    if (kind === 'noop') return;
    const paths = [oldP, newP].filter((p): p is string => p !== null);
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        for (const part of h.n) if (part.ctx === null) plus.push(part.text);
        if (h.hasPlus) final = !h.noEolPlus;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const cur = fileParts(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const oldLen = cur.lines.length;
        const pos = Math.min(Math.max(h.a + d, 0), oldLen);
        const ins = h.n.map((p) => p.text);
        cur.lines.splice(pos, 0, ...ins);
        if (pos === oldLen) cur.final = !h.noEolCtxPlus;
        d += ins.length;
        continue;
      }
      const m = matchFrom(cur.lines, h.o, 0, strict);
      if (m === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = m.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of m.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === cur.lines.length;
      const rep = buildN(cur.lines, best, h.o, h.n, m.tier);
      cur.lines.splice(best, h.o.length, ...rep);
      if (atEnd) cur.final = !h.noEolCtxPlus;
      d += h.n.length - h.o.length;
    }
    const out = joinFile(cur);
    if (kind === 'move') {
      tree.now.set(op, null);
      tree.now.set(newP!, out);
      moves.push([op, newP!]);
    } else {
      tree.now.set(op, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

interface SearchReplaceBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdit(block: SearchReplaceBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(block.path)) throw new Fail('unsafe', block.path);
    if (block.old.length === 0) {
      if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
      tree.now.set(block.path, block.nw.length === 0 ? '' : block.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(block.path);
    if (before === null) throw new Fail('missing', block.path);
    const cur = fileParts(before);
    const m = matchFrom(cur.lines, block.old, 0, strict);
    if (m === null) throw new Fail('no-match', block.path);
    if (m.positions.length > 1) throw new Fail('ambiguous', block.path);
    const pos = m.positions[0]!;
    const rep = buildN(cur.lines, pos, block.old, block.nw.map((t) => ({ text: t, ctx: null })), m.tier);
    cur.lines.splice(pos, block.old.length, ...rep);
    tree.now.set(block.path, joinFile(cur));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit({ path, old: oldLines, nw: newLines }, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  o: string[];
  n: NPart[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: Chunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const cur = fileParts(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const am = matchFrom(cur.lines, [ch.anchor], cursor, strict);
        if (am === null) throw new Fail('no-match', path);
        cursor = am.positions[0]! + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? cur.lines.length : cursor;
        const ins = ch.n.map((p) => p.text);
        cur.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const m = matchFrom(cur.lines, ch.o, cursor, strict);
      if (m === null) throw new Fail('no-match', path);
      let pos = -1;
      if (ch.eof) {
        for (const p of m.positions) {
          if (p + ch.o.length === cur.lines.length) {
            pos = p;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', path);
      } else {
        pos = m.positions[0]!;
      }
      const rep = buildN(cur.lines, pos, ch.o, ch.n, m.tier);
      cur.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(cur);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const bodyStart = i + 1;
    let j = bodyStart;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    const body = lines.slice(bodyStart, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | undefined;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < body.length; k++) {
        const bl = body[k]!;
        const lineNo = bodyStart + k + 1;
        if (bl.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: bl.slice(2).trim() || null, o: [], n: [], eof: false };
          continue;
        }
        if (bl === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          } else {
            chunks.push({ anchor: null, o: [], n: [], eof: true });
          }
          continue;
        }
        if (bl.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${lineNo}`);
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) cur = { anchor: null, o: [], n: [], eof: false };
          if (bl === '') {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          } else if (bl[0] === ' ') {
            const t = bl.slice(1);
            cur.o.push(t);
            cur.n.push({ text: t, ctx: cur.o.length - 1 });
          } else if (bl[0] === '-') {
            cur.o.push(bl.slice(1));
          } else {
            cur.n.push({ text: bl.slice(1), ctx: null });
          }
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict, moves)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rByNew = new Map<string, string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rByNew.set(newP, oldP);
    }
  }
  const rOlds = new Set<string>(rByNew.values());
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rByNew.has(p)) rows.push({ key: p, text: `R ${rByNew.get(p)} -> ${p}` });
    else if (rOlds.has(p)) continue;
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
