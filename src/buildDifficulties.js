// One-shot importer: John W. Haley, "An Examination of the Alleged Discrepancies
// of the Bible" (1874, public domain) into data/difficulties.sqlite - ~500
// alleged contradictions, each with the verses it reconciles and the page it
// is printed on, so the bot can ground an answer on it and cite "Haley, p. 336".
//
//   node src/buildDifficulties.js --haley <dir>/examinationof00hale [--torrey <dir>/difficultiesalle0000torr] [--out data/difficulties.sqlite]
//
// Torrey, "Difficulties and Alleged Errors and Contradictions in the Bible"
// (1907, public domain), is the second source and a different SHAPE: 24 essays
// on topics (Cain's wife, the Canaanites, "Were Jesus and Paul mistaken as to
// the time of our Lord's return?") rather than verse-keyed cases. It is stored
// in the same tables, chunked at paragraph boundaries, with EVERY reference
// marked non-primary - an essay that cites Deut 20:16 in passing is not ABOUT
// Deut 20:16, and automatic grounding uses primary references only. Torrey is
// reached by lookup_difficulty's keyword search, which is how people ask about
// him anyway: nobody asking about the Canaanites cites a verse.
//
// Source: https://archive.org/details/examinationof00hale - three files, all
// from the same OCR run: _hocr_searchtext.txt (the text), _hocr_pageindex.json
// (each scanned leaf's character range in that text), _page_numbers.json (leaf
// -> printed page). The mapping agrees with 434 of 469 running heads; every
// disagreement is the OCR misreading the HEAD ("69" for 59), not the mapping.
//
// WHAT THE OCR DOES TO THIS BOOK, AND WHAT IS DONE ABOUT IT
//
//  - Chapters are Roman numerals ("2 Sam. xxi. 19"), which parseScriptureRefs
//    does not read: converted here, with "1"/"l" accepted as a misread "i".
//  - Book names are damaged in regular ways (R/K/E: "Kom"; P/F/T: "Trov",
//    "Tet"; N/K/X: "Xum"). OCR_BOOKS corrects them, applied ONLY to the book
//    token of a reference match, never to running text. Every resulting
//    reference then passes the versification filter, so a correction that
//    produces a chapter the book does not have is dropped, not stored.
//  - Parts II-III quote the two conflicting texts in side-by-side columns, and
//    the OCR reads straight across them, interleaving the two verses line by
//    line. Spacing cannot separate them (some quoted lines have single spaces,
//    and justified prose has 4-5). The signal that works: quoted lines are made
//    of the entry's own KJV words, from bible.db; Haley's discussion is not.
//    The quotations are dropped - they are Bible text we already hold correctly.
//  - Haley repeats an entry's title at the top of a continuation page, with its
//    own OCR noise ("Obsei^ance" / "Observance"). A title within edit-distance
//    0.85 of the current one is a continuation, not a new entry.
//
// Haley BUNDLES related cases: "In a similar manner may be resolved the
// subjoined cases: Blind men. Matt. xx. 30 ..." So one entry can carry dozens
// of references, and they are genuinely his. References are stored as PRIMARY
// (title and quoted verses - the pair being reconciled) or discussion, so a
// lookup can prefer the entry that is ABOUT a verse over one that mentions it.

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { parseScriptureRefs } from './utils/scriptureRefs.js';
import { getVersification } from './utils/versification.js';
import { bibleWrapper } from './utils/bibleHelper.js';

const args = process.argv.slice(2);
const argVal = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const HALEY = argVal('--haley');
const TORREY = argVal('--torrey');
const OUT = argVal('--out') ?? path.join('data', 'difficulties.sqlite');
if (!HALEY || !fs.existsSync(`${HALEY}_hocr_searchtext.txt`)) {
    console.error('Usage: node src/buildDifficulties.js --haley <dir>/examinationof00hale [--out data/difficulties.sqlite]');
    process.exit(1);
}
if (TORREY && !fs.existsSync(`${TORREY}_hocr_searchtext.txt`)) {
    console.error(`[Difficulties] --torrey given but ${TORREY}_hocr_searchtext.txt does not exist`);
    process.exit(1);
}

// ── References ──────────────────────────────────────────────────────────────

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function roman(s) {
    s = s.toLowerCase();
    if (!/^[ivxlc]+$/.test(s)) return null;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const a = ROMAN[s[i]], b = ROMAN[s[i + 1]] ?? 0;
        n += a < b ? -a : a;
    }
    return n;
}

// Derived from the book tokens that failed to resolve in a first pass.
const OCR_BOOKS = {
    Kom: 'Rom', Eom: 'Rom', Ilom: 'Rom', Kev: 'Rev', Eev: 'Rev', Itev: 'Rev',
    Kum: 'Num', Xum: 'Num', Nnm: 'Num', Trov: 'Prov', Frov: 'Prov', Proy: 'Prov', Pmv: 'Prov',
    Mai: 'Mal', Fs: 'Ps', Ts: 'Ps', Vs: 'Ps', Ys: 'Ps', Jsa: 'Isa', Lsa: 'Isa', Lja: 'Isa', Liaiah: 'Isaiah',
    Kx: 'Ex', Dcut: 'Deut', Dent: 'Deut', Dout: 'Deut', Tet: 'Pet', Bet: 'Pet', Sara: 'Sam',
    Kmgs: 'Kings', Ejngs: 'Kings', Kzek: 'Ezek', Icncsis: 'Gen', Qen: 'Gen', Uen: 'Gen',
    Oal: 'Gal', Gial: 'Gal', Jal: 'Gal', Ileb: 'Heb', Hcb: 'Heb', Jolin: 'John',
    Chrou: 'Chron', Chion: 'Chron', Ghron: 'Chron', Cliron: 'Chron', Thil: 'Phil', Fhil: 'Phil', Philip: 'Phil',
    Acta: 'Acts', Jen: 'Jer', Jndg: 'Judg', Jiulg: 'Judg', Mutt: 'Matt', Josb: 'Josh', Kah: 'Nah',
    Cant: 'Song', Cantic: 'Song',
};

// "2 Sam. xxi. 19" -> "2 Sam 21:19". A comma is tolerated where the OCR read
// a period ("Eccl, vii. 29"), and a lone "1"/"l" as a misread numeral "i".
const REF = /\b((?:[1-3I]{1,3}\s+)?[A-Z][a-z]{1,8})[.,]?\s+([ivxlcIVXLC]{1,7}|1|l)[.,]\s+(\d{1,3}(?:\s*[-–]\s*\d{1,3})?)/g;
export function normalizeRefs(s) {
    return s.replace(REF, (m, book, rn, v) => {
        const ch = roman(rn === '1' || rn === 'l' ? 'i' : rn);
        if (!ch) return m;
        const fixed = book.replace(/[A-Z][a-z]+$/, w => OCR_BOOKS[w] ?? w);
        return `${fixed} ${ch}:${v.replace(/\s+/g, '')}`;
    });
}

// ── Line classes ────────────────────────────────────────────────────────────

const isColumn = l => /\S {4,}\S/.test(l.trim());
const isHead = l => /^(?:\d{1,3}\s+[A-Z][A-Z ]{6,}\.?|[A-Z][A-Z ]{6,}\.?\s+\d{1,3})\s*$/.test(l.trim());
const isSection = l => /^[IVX]+\.\s+[A-Z]{3,}/.test(l.trim());
const isFootnote = t => /^[*^†‡§•■]/.test(t);
const refLine = l => {
    const t = l.trim();
    return t.length < 80 && (t.match(REF) ?? []).length >= 1
        && !/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/.test(t.replace(REF, ''));
};
// "Made upright. Made sinful." / "Judas' death, — one manner. A diverse statement."
const twoClaims = t => t.length < 75 && (
    /^[A-Z][^.,]{2,60}\.\s+[A-Z][^.]{1,50}\.\s*$/.test(t)
    || /^[A-Z][^.]{2,50},\s*[—-]+\s*[A-Za-z][^.]{1,40}\.(?:\s+[A-Z][^.]{1,40}\.)?\s*$/.test(t));
const notTitle = t => /^[^A-Z]/.test(t) || /DISCREPANCIES|\bp\.\s*\d|\bchap\.|\bvol\./i.test(t) || (t.match(REF) ?? []).length > 0;
const endsPara = x => !x || /[.?!"'”)]\s*$/.test(x.trim()) || isSection(x);

const letters = x => x.toLowerCase().replace(/[^a-z]/g, '');
function similar(a, b) {
    a = letters(a); b = letters(b);
    if (!a || !b) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return 1 - d[a.length][b.length] / Math.max(a.length, b.length) >= 0.85;
}

// OCR residue worth fixing because the model may QUOTE Haley: a word-final
// "ll" read as "U" ("feU", "aU"), and "self" read as "seK" ("himseK").
const clean = s => s
    .replace(/[\^*■]/g, '')
    .replace(/\b([A-Za-z]*[a-z])U\b/g, '$1ll')
    .replace(/seK\b/g, 'self')
    .replace(/(\w)- (\w)/g, '$1$2')       // "breth- ren" rejoined across a line break
    .replace(/\s+/g, ' ')
    .trim();

// ── Parse ───────────────────────────────────────────────────────────────────

const text = fs.readFileSync(`${HALEY}_hocr_searchtext.txt`, 'utf8');
const lines = text.split('\n');
const start = lines.findIndex((l, i) => i > 500 && /^I\.\s+GOD/.test(l.trim()));
const end = lines.findIndex(l => /^BIBLIOGRAPHICAL\s+APPENDIX\.?\s*$/.test(l.trim()));
if (start < 0 || end < 0) {
    console.error(`[Difficulties] Could not find the body (start=${start}, end=${end}) - wrong file?`);
    process.exit(1);
}

const entries = [];
let cur = null, section = null, prev = '';
for (let i = start; i < end; i++) {
    const l = lines[i], t = l.trim();
    if (!t || isHead(l)) continue;
    if (isSection(l)) { section = clean(t); continue; }
    if (isFootnote(t)) continue;

    const next = lines.slice(i + 1, i + 4).find(x => x.trim() && !isHead(x)) ?? '';
    const byNext = !notTitle(t) && t.length < 90 && /\.\s*$/.test(t) && !isColumn(l) && !refLine(l)
        && (refLine(next) || isColumn(next));
    const byShape = !notTitle(t) && !isColumn(l) && !refLine(l) && twoClaims(t) && endsPara(prev);

    if (byNext || byShape) {
        prev = t;
        if (cur && similar(cur.title, t)) continue;
        // A title with nothing under it heads the entries that follow.
        if (cur && cur.lines.length === 0) { entries.pop(); section = `${section ?? ''} / ${clean(cur.title)}`; }
        cur = { title: t, section, lines: [], line: i };
        entries.push(cur);
        continue;
    }
    prev = t;
    if (cur) cur.lines.push(t);
}

// ── Split quoted verses from discussion; resolve references ────────────────

const versification = await getVersification();
const refsIn = s => versification.filter(parseScriptureRefs(normalizeRefs(s)));
const words = s => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

for (const e of entries) {
    const all = refsIn([e.title, ...e.lines].join('\n'));
    const kjv = new Set();
    for (const r of all) {
        const rows = await bibleWrapper.getVerses(r.bookId, r.chapter, r.startVerse ?? 1, r.endVerse ?? r.startVerse ?? 200)
            .catch(() => []);
        for (const row of rows) for (const w of words(row.KJV ?? '')) kjv.add(w);
    }
    let k = 0;
    for (; k < e.lines.length; k++) {
        const ws = words(e.lines[k].replace(REF, ' '));
        const overlap = ws.length ? ws.filter(w => kjv.has(w)).length / ws.length : 1;
        const hasRef = (e.lines[k].match(REF) ?? []).length > 0;
        if (!(overlap >= 0.7 || (hasRef && overlap >= 0.4))) break;
    }
    const primary = refsIn([e.title, ...e.lines.slice(0, k)].join('\n'));
    const key = r => `${r.bookId}:${r.chapter}:${r.startVerse ?? 0}`;
    const primaryKeys = new Set(primary.map(key));
    const seen = new Set();
    e.refs = [];
    for (const r of [...primary, ...all]) {
        if (seen.has(key(r))) continue;
        seen.add(key(r));
        e.refs.push({ ...r, primary: primaryKeys.has(key(r)) });
    }
    e.cleanTitle = clean(e.title);
    e.body = clean(normalizeRefs(e.lines.slice(k).join('\n')));
}

// ── Pages ───────────────────────────────────────────────────────────────────

const pageIndex = JSON.parse(fs.readFileSync(`${HALEY}_hocr_pageindex.json`, 'utf8'));
const printed = new Map(JSON.parse(fs.readFileSync(`${HALEY}_page_numbers.json`, 'utf8')).pages
    .map(p => [p.leafNum, p.pageNumber]));
const lineOffset = [];
{ let o = 0; for (const l of lines) { lineOffset.push(o); o += l.length + 1; } }
const pageOf = line => {
    const off = lineOffset[line];
    const leaf = pageIndex.findIndex(([a, b]) => a <= off && off < b);
    return printed.get(leaf) || null;
};
for (const e of entries) { e.page = pageOf(e.line); e.source = 'haley'; }

// ── Torrey ──────────────────────────────────────────────────────────────────

// searchtext has one PARAGRAPH per line here (595 lines for the book). A
// chapter starts at a Roman numeral - on the heading line ("VI WHERE DID CAIN
// GET HIS WIFE?") or alone on the line before it ("VII") - which the OCR varies
// ("Ix", "x", "XIV)", "XXT" for XXI). Running heads are also capitals, so the
// numeral is what separates a heading from "DAVID'S SIN 69".
const TORREY_CHUNK = 1500;
const titleCase = t => t.toLowerCase().replace(/(^|[\s“"‘(-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\b(Of|The|And|To|In|As|By|A|An|At|On|For)\b/g, (w, _x, i) => (i === 0 ? w : w.toLowerCase()));
function parseTorrey(prefix) {
    const tLines = fs.readFileSync(`${prefix}_hocr_searchtext.txt`, 'utf8').split('\n');
    const tIndex = JSON.parse(fs.readFileSync(`${prefix}_hocr_pageindex.json`, 'utf8'));
    const tPrinted = new Map(JSON.parse(fs.readFileSync(`${prefix}_page_numbers.json`, 'utf8')).pages
        .map(p => [p.leafNum, p.pageNumber]));
    const offsets = [];
    { let o = 0; for (const l of tLines) { offsets.push(o); o += l.length + 1; } }
    const pageAt = line => {
        const leaf = tIndex.findIndex(([a, b]) => a <= offsets[line] && offsets[line] < b);
        return tPrinted.get(leaf) || null;
    };

    const NUMERAL = /^[IVXLTivxl]{1,6}[).]?$/;
    const INLINE = /^([IVXLT]{1,5})[.)]?\s+(?=[“"‘A-Z])/;
    const isCaps = t => { const L = t.replace(/[^A-Za-z]/g, ''); return L.length >= 6 && L.replace(/[^A-Z]/g, '').length / L.length >= 0.85; };
    const isRunningHead = t => isCaps(t.replace(/\s+\S{1,4}$/, '')) && t.length < 70 && /\s(\S{1,4})$/.test(t) && !/[?]$/.test(t);
    const endAt = tLines.findIndex(l => /^INDEX OF BIBLE TEXTS/.test(l.trim()));

    const chapters = [];
    let chap = null;
    for (let i = 0; i < (endAt < 0 ? tLines.length : endAt); i++) {
        const t = tLines[i].trim();
        if (!t) continue;
        const prev = (tLines[i - 1] ?? '').trim();
        const inline = t.match(INLINE);
        const heading = (inline && isCaps(t.slice(inline[0].length)))
            ? t.slice(inline[0].length)
            : (NUMERAL.test(prev) && isCaps(t) ? t : null);
        if (heading) {
            const title = titleCase(heading.replace(/(\w)- (\w)/g, '$1$2').replace(/(^|\s)[‘']\s*(?=[A-Z])/g, '$1'));
            if (/^contents$/i.test(title.trim())) { chap = null; continue; }   // the front-matter TOC
            if (chap && chap.title === title) continue;                       // heading repeated on a continuation page
            chap = { title: titleCase(heading.replace(/(\w)- (\w)/g, '$1$2').replace(/(^|\s)[‘']\s*(?=[A-Z])/g, '$1')), paras: [] };
            chapters.push(chap);
            continue;
        }
        if (!chap) continue;
        if (NUMERAL.test(t) || isRunningHead(t) || /^\d[A-Z]/.test(t)) continue;  // numerals, heads, footnotes
        if (t.length < 40 && !/[a-z].*[.?!]$/.test(t)) continue;                   // page numbers, OCR debris
        chap.paras.push({ text: t, line: i });
    }

    const out = [];
    for (const c of chapters) {
        const chunks = [];
        let cur = [];
        for (const p of c.paras) {
            if (cur.length && cur.reduce((n, x) => n + x.text.length, 0) + p.text.length > TORREY_CHUNK) { chunks.push(cur); cur = []; }
            cur.push(p);
        }
        if (cur.length) chunks.push(cur);
        chunks.forEach((chunk, k) => {
            const body = clean(chunk.map(p => p.text).join('\n').replace(/(\d+):\s+(\d+)/g, '$1:$2'));
            const refs = versification.filter(parseScriptureRefs(body)).map(r => ({ ...r, primary: false }));
            out.push({
                source: 'torrey',
                cleanTitle: chunks.length > 1 ? `${c.title} (part ${k + 1} of ${chunks.length})` : c.title,
                section: c.title,
                body,
                page: pageAt(chunk[0].line),
                refs,
            });
        });
    }
    return { out, chapters: chapters.length };
}

let torreyChapters = 0;
if (TORREY) {
    const t = parseTorrey(TORREY);
    torreyChapters = new Set(t.out.map(e => e.section)).size;   // chapters that produced text
    entries.push(...t.out);
}

// ── Write ───────────────────────────────────────────────────────────────────

const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (err) { return err ? rej(err) : res(this); }));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const db = new sqlite3.Database(OUT);
await run(db, `CREATE TABLE difficulty_entries (
    id      INTEGER PRIMARY KEY,
    source  TEXT NOT NULL,
    title   TEXT NOT NULL,
    section TEXT,
    body    TEXT NOT NULL,
    page    TEXT
)`);
await run(db, `CREATE TABLE difficulty_refs (
    entry_id    INTEGER NOT NULL,
    book_id     INTEGER NOT NULL,
    chapter     INTEGER NOT NULL,
    start_verse INTEGER,
    end_verse   INTEGER,
    is_primary  INTEGER NOT NULL
)`);
await run(db, 'BEGIN');
let kept = 0, refCount = 0, primaryCount = 0, noRefs = 0;
for (const e of entries) {
    if (!e.body) continue;                  // title-only fragments carry nothing to ground on
    const { lastID } = await run(db,
        'INSERT INTO difficulty_entries (source, title, section, body, page) VALUES (?, ?, ?, ?, ?)',
        [e.source, e.cleanTitle, e.section, e.body, e.page]);
    kept++;
    if (!e.refs.length) noRefs++;
    for (const r of e.refs) {
        await run(db, 'INSERT INTO difficulty_refs VALUES (?, ?, ?, ?, ?, ?)',
            [lastID, r.bookId, r.chapter, r.startVerse ?? null, r.endVerse ?? r.startVerse ?? null, r.primary ? 1 : 0]);
        refCount++;
        if (r.primary) primaryCount++;
    }
}
await run(db, 'COMMIT');
await run(db, 'CREATE INDEX idx_difficulty_refs_loc ON difficulty_refs(book_id, chapter)');

// The cases that shaped this parser must survive it.
const SENTINELS = [
    { name: 'Goliath', book: 10, chapter: 21, verse: 19, page: '336', title: /Elhanan/ },
    { name: 'Judas', book: 40, chapter: 27, verse: 5, page: '349', title: /Judas/ },
    { name: 'Ahaziah', book: 12, chapter: 8, verse: 26, page: '398', title: /Ahaziah/ },
];
let failed = 0;
if (TORREY) {
    for (const [name, like] of [['Cain', '%Cain Get His Wife%'], ['Return', '%Mistaken as to the Time%'], ['Canaanites', '%Canaanites%']]) {
        const rows = await all(db, `SELECT title, page FROM difficulty_entries WHERE source = 'torrey' AND title LIKE ?`, [like]);
        console.log(`[Difficulties] sentinel torrey:${name.padEnd(10)} ${rows.length ? `ok  p.${rows[0].page} "${rows[0].title}" (${rows.length} chunk${rows.length === 1 ? '' : 's'})` : 'MISSING'}`);
        if (!rows.length) failed++;
    }
    console.log(`[Difficulties] torrey: ${torreyChapters} chapters`);
}
for (const s of SENTINELS) {
    const rows = await all(db, `
        SELECT e.title, e.page FROM difficulty_refs r JOIN difficulty_entries e ON e.id = r.entry_id
        WHERE r.book_id = ? AND r.chapter = ? AND r.start_verse <= ? AND r.end_verse >= ? AND r.is_primary = 1`,
    [s.book, s.chapter, s.verse, s.verse]);
    const hit = rows.find(r => s.title.test(r.title) && r.page === s.page);
    console.log(`[Difficulties] sentinel ${s.name.padEnd(8)} ${hit ? `ok  p.${hit.page} "${hit.title}"` : `MISSING (got ${JSON.stringify(rows)})`}`);
    if (!hit) failed++;
}
db.close();

console.log(`[Difficulties] ${kept} entries (${noRefs} without a reference), ${refCount} references (${primaryCount} primary) -> ${OUT}`);
if (failed) {
    console.error(`[Difficulties] ${failed} sentinel(s) failed - refusing to trust this build.`);
    process.exit(1);
}
process.exit(0);
