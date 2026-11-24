// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four shapes (a unified diff, SEARCH/REPLACE blocks, a
// V4A patch, or JSON edit objects), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none at all. The working
// directory is the root of the tree the patch edits. Node 22, standard library
// only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): that hand-over
// and runner.ts stay as the kit has them.

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `line` is the 1-based patch line. */
class ParseFail extends Error {
  constructor(line) {
    super(`parse ${line}`);
    Object.assign(this, { line });
  }
}

/** One edit failed; `code` is the SPEC.md failure code, `path` the file it concerns. */
class EditFail extends Error {
  constructor(code, path) {
    super(`${code} ${path}`);
    Object.assign(this, { code, path });
  }
}

const isBlank = (s) => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function cutLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or ... */
function pathOk(p) {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** UTF-8 byte order, for sorting output rows and write order. */
function cmpPath(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const trimTail = (s) => s.replace(/[ \t]+$/, '');
const trimBoth = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s) => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/**
 * A file as lines: `lines` holds the text split at its break, `br` is the break
 * (CRLF when the first line feed follows a carriage return, else LF), `tail`
 * says whether the text ends with that break. An empty file has no lines.
 */
function splitFile(text) {
  if (text === '') return { lines: [], br: '\n', tail: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let tail = false;
  if (text.endsWith(br)) {
    lines.pop();
    tail = true;
  }
  return { lines, br, tail };
}

function joinFile(model) {
  if (model.lines.length === 0) return '';
  return model.lines.join(model.br) + (model.tail ? model.br : '');
}

/** One line compared at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 both ends ignored. */
function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTail(a) === trimTail(b);
  return trimBoth(a) === trimBoth(b);
}

/**
 * The first tier (0, then 1, then 2; only 0 when strict) at which `needle` occurs
 * in `hay` at or after `from`, and every such occurrence. `good`, when given,
 * keeps only occurrences it accepts. Null when there is no occurrence at any tier.
 */
function findTier(hay, needle, from, strict, good) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = [];
    for (let i = from; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (!lineEq(hay[i + j], needle[j], t)) {
          ok = false;
          break;
        }
      }
      if (ok && (good === null || good(i))) spots.push(i);
    }
    if (spots.length > 0) return { tier: t, spots };
  }
  // No tier matched.
  return null;
}

/**
 * The lines that replace a match. A context item `{c}` is written as the file's
 * own matched line at that offset; a fresh item `{s}` is written as it is, except
 * at tier 2, where a non-blank line starting with P (the leading spaces/tabs of
 * O's first line) has that P replaced by F (those of the file's first matched
 * line). `oLead`/`fLead` are null when there is no matched line (an insertion).
 */
function buildNew(neu, fileLines, at, tier, oLead, fLead) {
  const out = [];
  for (const it of neu) {
    if ('c' in it) {
      out.push(fileLines[at + it.c]);
      continue;
    }
    let s = it.s;
    if (tier === 2 && oLead !== null && s.trim() !== '' && s.startsWith(oLead)) {
      s = fLead + s.slice(oLead.length);
    }
    out.push(s);
  }
  return out;
}

/**
 * The tree as the edits leave it. Originals are read lazily from disk and
 * cached; `now` holds what edits changed (null: deleted); `moves` records, in
 * patch order, the (old, new) pair of every move edit that succeeded.
 */
class Work {
  constructor() {
    this.orig = new Map();
    this.now = new Map();
    this.moves = [];
  }
  origOf(p) {
    if (!this.orig.has(p)) this.orig.set(p, this.readOriginal(p));
    return this.orig.get(p);
  }
  readOriginal(p) {
    try {
      if (!statSync(p).isFile()) return null;
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
  cur(p) {
    return this.now.has(p) ? this.now.get(p) : this.origOf(p);
  }
  put(p, v) {
    this.now.set(p, v);
  }
  snap() {
    return { now: new Map(this.now), moves: this.moves.length };
  }
  back(s) {
    this.now = s.now;
    this.moves.length = s.moves;
  }
}

/** One unified section: a creation, deletion, move, change, or a no-path no-op. */
function applyUni(w, e, strict) {
  if (e.oldP !== null && !pathOk(e.oldP)) throw new EditFail('unsafe', e.oldP);
  if (e.newP !== null && !pathOk(e.newP)) throw new EditFail('unsafe', e.newP);
  if (e.mode === 'noop') return;
  if (e.mode === 'create') {
    if (w.cur(e.newP) !== null) throw new EditFail('exists', e.newP);
    const lines = [];
    let tail = false;
    for (const h of e.hunks) {
      for (const it of h.neu) {
        if (!('s' in it)) continue;
        lines.push(it.s);
        tail = !it.slash;
      }
    }
    w.put(e.newP, joinFile({ lines, br: '\n', tail: lines.length > 0 && tail }));
    return;
  }
  const src = w.cur(e.oldP);
  if (src === null) throw new EditFail('missing', e.oldP);
  if (e.mode === 'delete') {
    w.put(e.oldP, null);
    return;
  }
  if (e.mode === 'move' && w.cur(e.newP) !== null) throw new EditFail('exists', e.newP);
  const m = splitFile(src);
  let d = 0;
  for (const h of e.hunks) {
    if (h.old.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > m.lines.length) pos = m.lines.length;
      const atEnd = pos === m.lines.length;
      const ins = buildNew(h.neu, m.lines, pos, 0, null, null);
      m.lines.splice(pos, 0, ...ins);
      if (atEnd) m.tail = !h.noBreak;
      d += h.neu.length;
      continue;
    }
    const found = findTier(m.lines, h.old, 0, strict, null);
    if (found === null) throw new EditFail('no-match', e.oldP);
    const target = h.a - 1 + d;
    let at = found.spots[0];
    let best = Math.abs(at - target);
    for (const s of found.spots) {
      const dist = Math.abs(s - target);
      if (dist < best) {
        at = s;
        best = dist;
      }
    }
    const touchesEnd = at + h.old.length === m.lines.length;
    const repl = buildNew(h.neu, m.lines, at, found.tier, leadOf(h.old[0]), leadOf(m.lines[at]));
    m.lines.splice(at, h.old.length, ...repl);
    if (touchesEnd) m.tail = !h.noBreak;
    d += h.neu.length - h.old.length;
  }
  const out = joinFile(m);
  if (e.mode === 'move') {
    w.put(e.newP, out);
    w.put(e.oldP, null);
    w.moves.push([e.oldP, e.newP]);
  } else {
    w.put(e.oldP, out);
  }
}

/** One SEARCH/REPLACE block: a creation when the old lines are empty, else a single replacement. */
function applySr(w, e, strict) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  if (e.old.length === 0) {
    if (w.cur(e.path) !== null) throw new EditFail('exists', e.path);
    w.put(e.path, joinFile({ lines: e.neu.map((it) => it.s), br: '\n', tail: e.neu.length > 0 }));
    return;
  }
  const src = w.cur(e.path);
  if (src === null) throw new EditFail('missing', e.path);
  const m = splitFile(src);
  const found = findTier(m.lines, e.old, 0, strict, null);
  if (found === null) throw new EditFail('no-match', e.path);
  if (found.spots.length > 1) throw new EditFail('ambiguous', e.path);
  const at = found.spots[0];
  const repl = buildNew(e.neu, m.lines, at, found.tier, leadOf(e.old[0]), leadOf(m.lines[at]));
  m.lines.splice(at, e.old.length, ...repl);
  w.put(e.path, joinFile(m));
}

/** A V4A Add File section: the file is the section's lines, ended by a line break. */
function applyVAdd(w, e) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  if (w.cur(e.path) !== null) throw new EditFail('exists', e.path);
  w.put(e.path, joinFile({ lines: e.lines.slice(), br: '\n', tail: e.lines.length > 0 }));
}

/** A V4A Delete File section. */
function applyVDel(w, e) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  if (w.cur(e.path) === null) throw new EditFail('missing', e.path);
  w.put(e.path, null);
}

/** A V4A Update File section: chunks in order, a cursor walking down the file. */
function applyVUp(w, e, strict) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  if (e.moveTo !== null && !pathOk(e.moveTo)) throw new EditFail('unsafe', e.moveTo);
  const src = w.cur(e.path);
  if (src === null) throw new EditFail('missing', e.path);
  if (e.moveTo !== null && w.cur(e.moveTo) !== null) throw new EditFail('exists', e.moveTo);
  const m = splitFile(src);
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const a = findTier(m.lines, [ch.anchor], cursor, strict, null);
      if (a === null) throw new EditFail('no-match', e.path);
      cursor = a.spots[0] + 1;
    }
    if (ch.old.length === 0) {
      const pos = ch.eof ? m.lines.length : cursor;
      const ins = buildNew(ch.neu, m.lines, pos, 0, null, null);
      m.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
      continue;
    }
    const good = ch.eof ? (i) => i + ch.old.length === m.lines.length : null;
    const f = findTier(m.lines, ch.old, cursor, strict, good);
    if (f === null) throw new EditFail('no-match', e.path);
    const at = f.spots[0];
    const repl = buildNew(ch.neu, m.lines, at, f.tier, leadOf(ch.old[0]), leadOf(m.lines[at]));
    m.lines.splice(at, ch.old.length, ...repl);
    cursor = at + repl.length;
  }
  const out = joinFile(m);
  if (e.moveTo !== null) {
    w.put(e.moveTo, out);
    w.put(e.path, null);
    w.moves.push([e.path, e.moveTo]);
  } else {
    w.put(e.path, out);
  }
}

/** A JSON create: file_text byte for byte. */
function applyJCreate(w, e) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  if (w.cur(e.path) !== null) throw new EditFail('exists', e.path);
  w.put(e.path, e.text);
}

/** A JSON str_replace: exact text match, once; CRLF files are normalised and restored. */
function applyJReplace(w, e) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  const src = w.cur(e.path);
  if (src === null) throw new EditFail('missing', e.path);
  const nl = src.indexOf('\n');
  const crlf = nl > 0 && src[nl - 1] === '\r';
  const norm = (s) => (crlf ? s.replaceAll('\r\n', '\n') : s);
  const t = norm(src);
  const o = norm(e.oldS);
  let count = 0;
  for (let k = t.indexOf(o); k >= 0; k = t.indexOf(o, k + 1)) count += 1;
  if (count === 0) throw new EditFail('no-match', e.path);
  if (count > 1) throw new EditFail('ambiguous', e.path);
  const at = t.indexOf(o);
  const out = t.slice(0, at) + norm(e.newS) + t.slice(at + o.length);
  w.put(e.path, crlf ? out.replaceAll('\n', '\r\n') : out);
}

/** A JSON insert: new lines spliced after line `at` (0 is the top). */
function applyJInsert(w, e) {
  if (!pathOk(e.path)) throw new EditFail('unsafe', e.path);
  const src = w.cur(e.path);
  if (src === null) throw new EditFail('missing', e.path);
  const m = splitFile(src);
  if (e.at < 0 || e.at > m.lines.length) throw new EditFail('no-match', e.path);
  m.lines.splice(e.at, 0, ...e.lines);
  w.put(e.path, joinFile(m));
}

/** One edit, whatever its format, applied to the tree as earlier edits left it. */
function applyOne(w, e, strict) {
  switch (e.k) {
    case 'uni':
      return applyUni(w, e, strict);
    case 'sr':
      return applySr(w, e, strict);
    case 'vadd':
      return applyVAdd(w, e);
    case 'vdel':
      return applyVDel(w, e);
    case 'vup':
      return applyVUp(w, e, strict);
    case 'jcreate':
      return applyJCreate(w, e);
    case 'jreplace':
      return applyJReplace(w, e);
    default:
      return applyJInsert(w, e);
  }
}

/** A `--- ` or `+++ ` path: after the four characters, up to the first tab, spaces trimmed, /dev/null is null, a leading a/ or b/ removed. */
function hdrPath(line) {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A unified diff: sections, each one edit. Prose and fences outside bodies are ignored. */
function parseUnified(lines) {
  const sections = [];
  let sec = null;
  const n = lines.length;
  const fresh = () => ({
    gitOld: undefined,
    gitNew: undefined,
    hdrOld: undefined,
    hdrNew: undefined,
    hasPair: false,
    renOld: undefined,
    renNew: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
    sawHunk: false,
  });
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0) throw new ParseFail(i + 1);
      const x = rest.slice(2, sep);
      const y = rest.slice(sep + 3);
      if (x === '' || y === '') throw new ParseFail(i + 1);
      sec = fresh();
      sec.gitOld = x;
      sec.gitNew = y;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.sawHunk || sec.hasPair) {
        sec = fresh();
        sections.push(sec);
      }
      sec.hdrOld = hdrPath(l);
      sec.hdrNew = hdrPath(lines[i + 1]);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (sec !== null && !sec.sawHunk) throw new ParseFail(i + 2);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new ParseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new ParseFail(i + 1);
      sec.sawHunk = true;
      const recs = [];
      i += 1;
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          recs.push({ kind: 'ctx', text: '', bare: true, slash: false });
          i += 1;
          continue;
        }
        const ch = b[0];
        if (ch === ' ') {
          recs.push({ kind: 'ctx', text: b.slice(1), bare: false, slash: false });
        } else if (ch === '-') {
          recs.push({ kind: 'del', text: b.slice(1), bare: false, slash: false });
        } else if (ch === '+') {
          recs.push({ kind: 'add', text: b.slice(1), bare: false, slash: false });
        } else if (ch === '\\') {
          if (recs.length > 0) recs[recs.length - 1].slash = true;
        } else {
          break;
        }
        i += 1;
      }
      while (recs.length > 0 && recs[recs.length - 1].bare) recs.pop();
      const old = [];
      const neu = [];
      for (const r of recs) {
        if (r.kind === 'ctx') {
          old.push(r.text);
          neu.push({ c: old.length - 1, slash: r.slash });
        } else if (r.kind === 'del') {
          old.push(r.text);
        } else {
          neu.push({ s: r.text, slash: r.slash });
        }
      }
      sec.hunks.push({ a: Number(m[1]), old, neu, noBreak: neu.length > 0 ? neu[neu.length - 1].slash : false });
      continue;
    }
    if (sec !== null && !sec.sawHunk) {
      if (l.startsWith('rename from ')) sec.renOld = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) sec.renNew = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
    }
    i += 1;
  }
  const out = [];
  for (const s of sections) {
    const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renOld !== undefined ? s.renOld : s.gitOld;
    const newP = s.hdrNew !== undefined ? s.hdrNew : s.renNew !== undefined ? s.renNew : s.gitNew;
    let mode;
    if (oldP === null && newP === null) mode = 'noop';
    else if (oldP === null) mode = 'create';
    else if (newP === null) mode = 'delete';
    else if (s.newFile) mode = 'create';
    else if (s.delFile) mode = 'delete';
    else if (oldP !== newP) mode = 'move';
    else mode = 'change';
    out.push({ k: 'uni', oldP, newP, mode, hunks: s.hunks });
  }
  return out;
}

/** SEARCH/REPLACE blocks, in order. Lines outside blocks are ignored. */
function parseSearch(lines) {
  const out = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath = null;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseFail(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFail(searchIdx + 1);
    let path = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(searchIdx + 1);
      path = prevPath;
    }
    const old = lines.slice(searchIdx + 1, eq);
    const neu = lines.slice(eq + 1, rep).map((s) => ({ s }));
    out.push({ k: 'sr', path, old, neu });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return out;
}

const V4A_HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4aHead = (l) => V4A_HEADS.some((h) => l.startsWith(h));

/** The body of one V4A Update File section: an optional Move to, then chunks. `base` is the 0-based index of the body's first line; `hdrLine` the 1-based line of the Update File line. */
function parseV4Update(path, body, base, hdrLine) {
  let moveTo = null;
  let k = 0;
  if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
    moveTo = body[0].slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks = [];
  let cur = null;
  for (; k < body.length; k++) {
    const c = body[k];
    const lineNo = base + 1 + k;
    if (c.trim() === '*** End of File') {
      if (cur === null) throw new ParseFail(lineNo);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (c.startsWith('@@')) {
      cur = { anchor: c.slice(2).trim() === '' ? null : c.slice(2).trim(), old: [], neu: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (c === '' || c[0] === ' ' || c[0] === '-' || c[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseFail(lineNo);
        cur = { anchor: null, old: [], neu: [], eof: false };
        chunks.push(cur);
      }
      if (c === '') {
        cur.old.push('');
        cur.neu.push({ c: cur.old.length - 1 });
      } else if (c[0] === ' ') {
        cur.old.push(c.slice(1));
        cur.neu.push({ c: cur.old.length - 1 });
      } else if (c[0] === '-') {
        cur.old.push(c.slice(1));
      } else {
        cur.neu.push({ s: c.slice(1) });
      }
      continue;
    }
    throw new ParseFail(lineNo);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFail(hdrLine);
  return { k: 'vup', path, moveTo, chunks };
}

/** A V4A patch: Begin, sections, End. Blank lines at the end of a section are not part of it. */
function parseV4a(lines) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const out = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i += 1;
      continue;
    }
    const l = lines[i];
    let kind = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFail(i + 1);
    }
    let j = i + 1;
    while (j < last && !isV4aHead(lines[j])) j += 1;
    let end = j;
    while (end > i + 1 && isBlank(lines[end - 1])) end -= 1;
    const body = lines.slice(i + 1, end);
    if (kind === 'add') {
      const added = [];
      for (let b = 0; b < body.length; b++) {
        const c = body[b];
        if (c.startsWith('+')) added.push(c.slice(1));
        else if (c === '') added.push('');
        else throw new ParseFail(i + 2 + b);
      }
      out.push({ k: 'vadd', path, lines: added });
    } else if (kind === 'del') {
      for (let b = 0; b < body.length; b++) {
        if (!isBlank(body[b])) throw new ParseFail(i + 2 + b);
      }
      out.push({ k: 'vdel', path });
    } else {
      out.push(parseV4Update(path, body, i + 1, i + 1));
    }
    i = j;
  }
  return out;
}

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v.path;
  if (typeof p !== 'string') return null;
  if (v.command === 'create') {
    if (typeof v.file_text !== 'string') return null;
    return { k: 'jcreate', path: p, text: v.file_text };
  }
  if (v.command === 'str_replace') {
    if (typeof v.old_str !== 'string' || v.old_str === '') return null;
    if (v.new_str !== undefined && typeof v.new_str !== 'string') return null;
    return { k: 'jreplace', path: p, oldS: v.old_str, newS: v.new_str === undefined ? '' : v.new_str };
  }
  if (v.command === 'insert') {
    if (typeof v.insert_line !== 'number' || !Number.isInteger(v.insert_line)) return null;
    if (typeof v.new_str !== 'string') return null;
    return { k: 'jinsert', path: p, at: v.insert_line, lines: cutLines(v.new_str) };
  }
  // Not a valid edit object.
  return null;
}

/** JSON.parse that answers undefined instead of throwing. */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One JSON Lines line as an edit, or null when it does not hold one. */
function tryJsonEdit(line) {
  const v = tryParse(line);
  if (v === undefined) return null;
  return jsonEdit(v);
}

/** JSON edits: one array, or one edit object per line. */
function parseJson(text, lines) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail(1);
  const list = [];
  if (lines[first].trimStart().startsWith('[')) {
    const v = tryParse(text);
    if (!Array.isArray(v)) throw new ParseFail(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFail(first + 1);
      list.push(e);
    }
    return list;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    const e = tryJsonEdit(lines[i]);
    if (e === null) throw new ParseFail(i + 1);
    list.push(e);
  }
  return list;
}

/** Format detection, in the order section 4 gives: v4a, json, search-replace, unified. */
function detect(lines) {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first].trimStart();
  if (head[0] === '[' || head[0] === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  // Nothing matched: no format.
  return null;
}

/** The patch's text: from a file, or from standard input when there is none. Null when the file cannot be read. */
function readPatch(file) {
  try {
    return readFileSync(file === null ? 0 : file, 'utf8');
  } catch {
    return file === null ? '' : null;
  }
}

/** One changed path written out: deleted when its new text is null, else created or overwritten. */
function writeOut(p, text) {
  if (text === null) {
    rmSync(p, { force: true });
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function run(args) {
  let format = null;
  let check = false;
  let strict = false;
  const pos = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  const text = readPatch(file);
  if (text === null) return { code: 2, out: ['error: no-patch'] };
  const lines = cutLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits;
  try {
    if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearch(lines);
    else if (kind === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new ParseFail(1);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const w = new Work();
  const fails = [];
  for (const e of edits) {
    const snap = w.snap();
    try {
      applyOne(w, e, strict);
    } catch (err) {
      if (!(err instanceof EditFail)) throw err;
      w.back(snap);
      fails.push(err);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const changed = new Map();
  for (const p of w.now.keys()) {
    const was = w.origOf(p);
    const now = w.now.get(p);
    if (was !== now) changed.set(p, { was, now });
  }
  const rows = [];
  const claimed = new Set();
  for (const [o, nw] of w.moves) {
    const oc = changed.get(o);
    const nc = changed.get(nw);
    if (oc === undefined || nc === undefined) continue;
    if (oc.was === null || oc.now !== null) continue;
    if (nc.was !== null || nc.now === null) continue;
    if (claimed.has(o) || claimed.has(nw)) continue;
    claimed.add(o);
    claimed.add(nw);
    rows.push({ key: nw, text: `R ${o} -> ${nw}` });
  }
  for (const [p, c] of changed) {
    if (claimed.has(p)) continue;
    const tag = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${tag} ${p}` });
  }
  rows.sort((a, b) => cmpPath(a.key, b.key));
  if (!check) {
    for (const p of [...changed.keys()].sort(cmpPath)) writeOut(p, changed.get(p).now);
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
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
