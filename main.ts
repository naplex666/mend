// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (MIT, kit starter
// extended to the full specification). It does all of SPEC.md: the command line, the output and exit codes,
// safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write with move lines (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines: its own break, whether it ends with one. SPEC.md section 3. */
interface FileText { lines: string[]; br: string; final: boolean; }
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
const leadingWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };

/** What the parsers share: strict matching, and the moves applied so far. */
interface Ctx { strict: boolean; moves: { old: string; nw: string }[]; }

/** A hunk or chunk: old lines O, new lines N; nCtx[j] is N[j]'s index in O when it is a context line, else -1. */
interface Span { o: string[]; n: string[]; nCtx: number[]; }
function spanFrom(items: { kind: 'ctx' | 'old' | 'new'; text: string }[]): Span {
  const o: string[] = []; const n: string[] = []; const nCtx: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') { nCtx.push(o.length); o.push(it.text); n.push(it.text); }
    else if (it.kind === 'old') o.push(it.text);
    else { nCtx.push(-1); n.push(it.text); }
  }
  return { o, n, nCtx };
}

/** Section 5: the three matching tiers. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]!) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** First tier with an occurrence at or after `from`, and its first such position. */
function findTierFrom(file: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, o, t);
    for (const p of occ) if (p >= from) return { tier: t, pos: p };
  }
  return null;
}
function reindentLine(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}
/** Replace file[pos .. pos+O.length) by the span's N lines (section 5). */
function applySpan(file: FileText, pos: number, span: Span, tier: number): FileText {
  const f = span.o.length > 0 ? leadingWs(file.lines[pos]!) : '';
  const p = span.o.length > 0 ? leadingWs(span.o[0]!) : '';
  const repl = span.n.map((line, j) => {
    const oi = span.nCtx[j]!;
    if (oi >= 0) return file.lines[pos + oi]!;
    if (tier === 2) return reindentLine(line, f, p);
    return line;
  });
  return { lines: [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + span.o.length)], br: file.br, final: file.final };
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

/** Section 6: unified diffs. */
interface Hunk {
  a: number;
  items: { kind: 'ctx' | 'old' | 'new'; text: string; bs: boolean }[];
}
interface USection {
  oldPath: string; newPath: string;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}
function parseDiffGit(line: string, n: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${n}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${n}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${n}`);
  return [x, y];
}
function parseHunkHeader(line: string, n: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return Number(m[1]);
}
function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const isSectionStart = (j: number): boolean => {
    if (j >= n) return false;
    if (lines[j]!.startsWith('diff --git ')) return true;
    if (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) return true;
    return false;
  };
  let i = 0;
  while (i < n) {
    if (!isSectionStart(i)) { i++; continue; }
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let create = false;
    let del = false;
    if (lines[i]!.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(lines[i]!, i + 1);
      oldPath = x; newPath = y;
      i++;
    } else {
      oldPath = stripAB(headerPath(lines[i]!));
      newPath = stripAB(headerPath(lines[i + 1]!));
      i += 2;
    }
    const hunks: Hunk[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        oldPath = stripAB(headerPath(l));
        newPath = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) { oldPath = l.slice('rename from '.length).trim(); i++; continue; }
      if (l.startsWith('rename to ')) { newPath = l.slice('rename to '.length).trim(); i++; continue; }
      if (l.startsWith('new file mode')) { create = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { del = true; i++; continue; }
      i++;
    }
    while (i < n) {
      const l = lines[i]!;
      if (!l.startsWith('@@')) break;
      const a = parseHunkHeader(l, i + 1);
      i++;
      const items: Hunk['items'] = [];
      let prevItem: Hunk['items'][number] | null = null;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('\\')) {
          if (prevItem !== null && (prevItem.kind === 'ctx' || prevItem.kind === 'new')) prevItem.bs = true;
          prevItem = null;
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          let it: Hunk['items'][number];
          if (b === '') it = { kind: 'ctx', text: '', bs: false };
          else if (b.startsWith(' ')) it = { kind: 'ctx', text: b.slice(1), bs: false };
          else if (b.startsWith('-')) it = { kind: 'old', text: b.slice(1), bs: false };
          else it = { kind: 'new', text: b.slice(1), bs: false };
          items.push(it);
          prevItem = it;
          i++;
          continue;
        }
        break;
      }
      while (items.length > 0) {
        const t = items[items.length - 1]!;
        if (t.kind === 'ctx' && t.text === '') items.pop();
        else break;
      }
      hunks.push({ a, items });
    }
    const sec: USection = {
      oldPath: oldPath!, newPath: newPath!,
      kind: oldPath === '/dev/null' || create ? 'create' : newPath === '/dev/null' || del ? 'delete' : oldPath !== newPath ? 'move' : 'change',
      hunks,
    };
    edits.push(unifiedEdit(sec, ctx));
  }
  return edits;
}
function hunkNoNewline(h: Hunk): boolean {
  for (let k = h.items.length - 1; k >= 0; k--) {
    const it = h.items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.bs;
  }
  return false;
}
function unifiedEdit(sec: USection, ctx: Ctx): Edit {
  return (tree) => {
    const fail = (code: string, path: string): never => { throw new Fail(code, path); };
    if (sec.kind === 'create') {
      if (!safe(sec.newPath)) fail('unsafe', sec.newPath);
      if (tree.get(sec.newPath) !== null) fail('exists', sec.newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let noNl = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const items = sec.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === 'new') { noNl = items[k]!.bs; break outer; }
        }
      }
      tree.now.set(sec.newPath, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.oldPath)) fail('unsafe', sec.oldPath);
      if (tree.get(sec.oldPath) === null) fail('missing', sec.oldPath);
      tree.now.set(sec.oldPath, null);
      return;
    }
    if (!safe(sec.oldPath)) fail('unsafe', sec.oldPath);
    if (sec.kind === 'move' && !safe(sec.newPath)) fail('unsafe', sec.newPath);
    const before = tree.get(sec.oldPath);
    if (before === null) fail('missing', sec.oldPath);
    if (sec.kind === 'move' && tree.get(sec.newPath) !== null) fail('exists', sec.newPath);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const span = spanFrom(h.items);
      if (span.o.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const atEnd = at === f.lines.length;
        const lines = [...f.lines.slice(0, at), ...span.n, ...f.lines.slice(at)];
        f = { lines, br: f.br, final: atEnd ? !hunkNoNewline(h) : f.final };
        d += span.n.length;
        continue;
      }
      const found = findTier(f.lines, span.o, ctx.strict);
      if (found === null) fail('no-match', sec.oldPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!; let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) { best = pos; bestDist = dist; }
      }
      const runsToEnd = best + span.o.length === f.lines.length;
      const nf = applySpan(f, best, span, found.tier);
      f = { lines: nf.lines, br: f.br, final: runsToEnd ? !hunkNoNewline(h) : f.final };
      d += span.n.length - span.o.length;
    }
    const text = joinFile(f);
    if (sec.kind === 'move') {
      tree.now.set(sec.newPath, text);
      tree.now.set(sec.oldPath, null);
      ctx.moves.push({ old: sec.oldPath, nw: sec.newPath });
    } else {
      tree.now.set(sec.oldPath, text);
    }
  };
}

/** Section 7: SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j++) { if (lines[j]!.trimEnd() === '=======') { eq = j; break; } }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) { if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; } }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, ctx));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}
function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const span: Span = { o: oldLines, n: newLines, nCtx: newLines.map(() => -1) };
    const nf = applySpan(f, found.occ[0]!, span, found.tier);
    tree.now.set(path, joinFile(nf));
  };
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  items: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}
function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) { if (!blank(lines[j]!)) { last = j; break; } }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        if (b.startsWith('+')) { flines.push(b.slice(1)); i++; continue; }
        if (b === '') { flines.push(''); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let closed = false;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        if (b.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          closed = true;
          i++;
          continue;
        }
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
          closed = false;
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (closed) throw new Exit2(`error: parse ${i + 1}`);
          if (cur === null) {
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          if (b === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (b.startsWith(' ')) cur.items.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) cur.items.push({ kind: 'old', text: b.slice(1) });
          else cur.items.push({ kind: 'new', text: b.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.items.length > 0) {
          const t = lc.items[lc.items.length - 1]!;
          if (t.kind === 'ctx' && t.text === '') lc.items.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, ctx));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTierFrom(f.lines, [ch.anchor], cursor, ctx.strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.pos + 1;
      }
      const span = spanFrom(ch.items);
      if (span.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, at), ...span.n, ...f.lines.slice(at)];
        f = { lines, br: f.br, final: f.final };
        cursor = at + span.n.length;
        continue;
      }
      if (ch.eof) {
        const p = f.lines.length - span.o.length;
        if (p < cursor) throw new Fail('no-match', path);
        let tier: number | null = null;
        for (const t of ctx.strict ? [0] : [0, 1, 2]) {
          if (occurrences(f.lines, span.o, t).includes(p)) { tier = t; break; }
        }
        if (tier === null) throw new Fail('no-match', path);
        const nf = applySpan(f, p, span, tier);
        f = nf;
        cursor = p + span.n.length;
        continue;
      }
      const found = findTierFrom(f.lines, span.o, cursor, ctx.strict);
      if (found === null) throw new Fail('no-match', path);
      const nf = applySpan(f, found.pos, span, found.tier);
      f = nf;
      cursor = found.pos + span.n.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      ctx.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, ctx)
      : kind === 'search-replace' ? parseSearchReplace(lines, ctx)
      : parseV4a(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const m0 = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = m0;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of ctx.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      changed.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      suppressed.add(m.old);
      suppressed.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
