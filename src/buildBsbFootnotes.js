// One-shot importer: the Berean Standard Bible's translator footnotes into
// data/bsb_footnotes.sqlite, keyed by the same (book_id, chapter, verse) as
// bible.db, so a runtime lookup is one indexed read.
//
//   node src/buildBsbFootnotes.js <database.db> [--out data/bsb_footnotes.sqlite]
//
// Source: Kenneth's local archive, data/new_data/database.db, table `bible`.
// Its `footnote` column holds one note per line as "<charOffset>#<text>". The
// offset points into that archive's own segmented text (rows split at headings
// and paragraphs), which does not line up with bible.db's one-row-per-verse
// BSB, so offsets are dropped and only the note text is kept.
//
// WHY THIS EXISTS
//
// bible.db stores the BSB as plain verse text, footnotes stripped. Asked
// whether the BSB "tampered" with 2 Sam 21:19 by inserting "the brother of",
// the bot could not see the BSB's own note - "Hebrew does not include the
// brother of" - and so first invented a Hebrew reading to defend it, then
// invented a missing footnote to condemn it. Both errors were about a fact
// that was printed on the page and absent from our data.
//
// Verse-0 rows (psalm superscriptions and headings) are skipped: no reference
// the bot parses has verse 0. The count is reported so it is a decision, not a
// silent loss.

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : path.join('data', 'bsb_footnotes.sqlite');

if (!src || !fs.existsSync(src)) {
    console.error('Usage: node src/buildBsbFootnotes.js <database.db> [--out data/bsb_footnotes.sqlite]');
    process.exit(1);
}

const all = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, e => (e ? rej(e) : res())));

const source = new sqlite3.Database(src, sqlite3.OPEN_READONLY);
const rows = await all(source,
    `SELECT book, chapter, verse, footnote FROM bible
     WHERE footnote IS NOT NULL AND footnote <> ''
     ORDER BY book, chapter, verse, _id`);
source.close();

// Collapse segments into verses, keep note order, drop exact duplicates.
const byVerse = new Map();
let skippedVerseZero = 0;
let malformed = 0;
for (const r of rows) {
    if (!(r.verse > 0)) { skippedVerseZero++; continue; }
    const key = `${r.book}:${r.chapter}:${r.verse}`;
    if (!byVerse.has(key)) byVerse.set(key, { book: r.book, chapter: r.chapter, verse: r.verse, notes: [] });
    const entry = byVerse.get(key);
    for (const line of String(r.footnote).split('\n')) {
        const m = line.match(/^\s*\d+#(.+)$/);
        if (!m) { if (line.trim()) malformed++; continue; }
        const text = m[1].trim();
        if (text && !entry.notes.includes(text)) entry.notes.push(text);
    }
}

if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new sqlite3.Database(out);
await run(db, `CREATE TABLE bsb_footnotes (
    book_id INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    verse   INTEGER NOT NULL,
    seq     INTEGER NOT NULL,
    text    TEXT    NOT NULL
)`);
await run(db, 'BEGIN');
let noteCount = 0;
for (const v of byVerse.values()) {
    for (let i = 0; i < v.notes.length; i++) {
        await run(db, 'INSERT INTO bsb_footnotes VALUES (?, ?, ?, ?, ?)', [v.book, v.chapter, v.verse, i, v.notes[i]]);
        noteCount++;
    }
}
await run(db, 'COMMIT');
await run(db, 'CREATE INDEX idx_bsb_footnotes_loc ON bsb_footnotes(book_id, chapter, verse)');

// The case that motivated this file must survive the import.
const sentinel = await all(db, 'SELECT text FROM bsb_footnotes WHERE book_id = 10 AND chapter = 21 AND verse = 19 ORDER BY seq');
db.close();

console.log(`[BsbFootnotes] ${noteCount} notes across ${byVerse.size} verses -> ${out}`);
console.log(`[BsbFootnotes] skipped: ${skippedVerseZero} verse-0 rows (superscriptions/headings), ${malformed} malformed lines`);
console.log(`[BsbFootnotes] 2 Sam 21:19: ${sentinel.map(s => JSON.stringify(s.text)).join(' | ') || 'MISSING'}`);
if (!sentinel.some(s => /does not include the brother of/i.test(s.text))) {
    console.error('[BsbFootnotes] Sentinel footnote missing - refusing to trust this build.');
    process.exit(1);
}
