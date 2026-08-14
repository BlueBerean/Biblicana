// One-shot importer: Brenton's English Septuagint (1851, public domain) into
// data/lxx.sqlite, keyed by MASORETIC coordinates so runtime lookups look like
// every other wrapper in the bot.
//
//   node src/buildLxx.js <eng-Brenton_vpl.txt> [--out data/lxx.sqlite]
//
// Source: https://ebible.org/find/show.php?id=eng-Brenton  (verse-per-line zip)
// Format: "GEN 1:1 In the beginning God made the heaven and the earth."
//
// WHY A MAPPING IS NEEDED AT ALL
//
// Brenton prints the LXX's own versification, which differs from the Hebrew:
// "Create in me a clean heart" is Psalm 51:10 in every English Bible and
// Psalm 50:12 here. A naive join on (chapter, verse) would return a real verse
// from the wrong psalm — plausible, fluent, and wrong, which is the worst
// failure this bot can produce.
//
// The alignment is therefore done ONCE, here, and the result stored against our
// coordinates. Runtime never maps anything.
//
// WHAT IS TRUSTED AND WHAT IS CHECKED
//
// Nothing is trusted. Every mapped chapter is scored by lexical overlap against
// the Masoretic English already in bible.db, and any chapter that fails to
// corroborate is marked approx=1 rather than silently shipped. The report at
// the end is the artifact worth reading.

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { BOOKS } from './utils/bookNames.js';

// ── Book codes ────────────────────────────────────────────────────────────
//
// Brenton's file uses USFM codes, which mostly match our osis3 but not always
// (EZE vs EZK, JOE vs JOL, NAH vs NAM, SOL vs SNG). Written out explicitly
// rather than derived, so a mismatch is a startup error instead of a silently
// skipped book.
const USFM_TO_CANONICAL = {
    GEN: 'Genesis', EXO: 'Exodus', LEV: 'Leviticus', NUM: 'Numbers', DEU: 'Deuteronomy',
    JOS: 'Joshua', JDG: 'Judges', RUT: 'Ruth', '1SA': '1 Samuel', '2SA': '2 Samuel',
    '1KI': '1 Kings', '2KI': '2 Kings', '1CH': '1 Chronicles', '2CH': '2 Chronicles',
    EZR: 'Ezra', NEH: 'Nehemiah', JOB: 'Job', PSA: 'Psalms', PRO: 'Proverbs',
    ECC: 'Ecclesiastes', SOL: 'Song of Solomon', ISA: 'Isaiah', JER: 'Jeremiah',
    LAM: 'Lamentations', EZE: 'Ezekiel', HOS: 'Hosea', JOE: 'Joel', AMO: 'Amos',
    OBA: 'Obadiah', JON: 'Jonah', MIC: 'Micah', NAH: 'Nahum', HAB: 'Habakkuk',
    ZEP: 'Zephaniah', HAG: 'Haggai', ZEC: 'Zechariah', MAL: 'Malachi',
    // Greek forms of books we also hold in Hebrew. Chapters line up; verse
    // numbering diverges where the Greek additions sit, which verification
    // catches and flags rather than us guessing.
    DNG: 'Daniel', ESG: 'Esther',
};

// Books with no Masoretic counterpart. Reachable only by their own name, so
// they carry display names and search aliases instead of a bookId.
const DEUTERO = {
    TOB: { name: 'Tobit',                aliases: ['tobit', 'tob'] },
    JDT: { name: 'Judith',               aliases: ['judith', 'jdt'] },
    WIS: { name: 'Wisdom of Solomon',    aliases: ['wisdom', 'wisdom of solomon', 'wis'] },
    SIR: { name: 'Sirach',               aliases: ['sirach', 'ecclesiasticus', 'sir'] },
    BAR: { name: 'Baruch',               aliases: ['baruch', 'bar'] },
    EPJ: { name: 'Epistle of Jeremiah',  aliases: ['epistle of jeremiah', 'letter of jeremiah', 'epjer'] },
    SUS: { name: 'Susanna',              aliases: ['susanna', 'sus'] },
    BEL: { name: 'Bel and the Dragon',   aliases: ['bel and the dragon', 'bel'] },
    PRM: { name: 'Prayer of Manasseh',   aliases: ['prayer of manasseh', 'manasseh', 'prman'] },
    '1ES': { name: '1 Esdras',           aliases: ['1 esdras', 'first esdras', '1esd'] },
    '1MA': { name: '1 Maccabees',        aliases: ['1 maccabees', 'first maccabees', '1macc', '1mac'] },
    '2MA': { name: '2 Maccabees',        aliases: ['2 maccabees', 'second maccabees', '2macc', '2mac'] },
    '3MA': { name: '3 Maccabees',        aliases: ['3 maccabees', 'third maccabees', '3macc', '3mac'] },
    '4MA': { name: '4 Maccabees',        aliases: ['4 maccabees', 'fourth maccabees', '4macc', '4mac'] },
};

const canonicalToId = new Map(BOOKS.map(b => [b.canonical, b.id]));

// ── Jeremiah ──────────────────────────────────────────────────────────────
//
// The LXX book is about an eighth shorter and puts the oracles against the
// nations (Masoretic 46-51) in the MIDDLE, after 25:13, in a different order
// among themselves. Expressed as MASORETIC ranges mapped onto LXX ranges,
// since a Masoretic reference is what a user types.
//
// Verse offsets are derived from the range endpoints rather than written out,
// and every range is corroborated against bible.db before shipping.
const JEREMIAH_RANGES = [
    // Masoretic start/end            LXX chapter, LXX start verse
    { mtCh: 25, mtFrom: 15, mtTo: 38, lxxCh: 32, lxxFrom: 1 },
    { mtCh: 46, mtFrom: 1, mtTo: 28, lxxCh: 26, lxxFrom: 1 },
    { mtCh: 47, mtFrom: 1, mtTo: 7, lxxCh: 29, lxxFrom: 1 },
    { mtCh: 48, mtFrom: 1, mtTo: 47, lxxCh: 31, lxxFrom: 1 },
    { mtCh: 49, mtFrom: 1, mtTo: 5, lxxCh: 30, lxxFrom: 17 },   // Ammon
    { mtCh: 49, mtFrom: 7, mtTo: 22, lxxCh: 30, lxxFrom: 1 },   // Edom
    { mtCh: 49, mtFrom: 23, mtTo: 27, lxxCh: 30, lxxFrom: 29 }, // Damascus
    { mtCh: 49, mtFrom: 28, mtTo: 33, lxxCh: 30, lxxFrom: 23 }, // Kedar
    { mtCh: 49, mtFrom: 34, mtTo: 39, lxxCh: 25, lxxFrom: 14 }, // Elam
    { mtCh: 50, mtFrom: 1, mtTo: 46, lxxCh: 27, lxxFrom: 1 },   // Babylon
    { mtCh: 51, mtFrom: 1, mtTo: 64, lxxCh: 28, lxxFrom: 1 },
    { mtCh: 45, mtFrom: 1, mtTo: 5, lxxCh: 51, lxxFrom: 31 },   // appended to LXX 51
];

// 3 Kingdoms swaps two chapters relative to the Hebrew: Naboth's vineyard and
// the Aramean wars trade places. A verse-level offset cannot express a chapter
// swap, so it is stated rather than derived.
const CHAPTER_SWAPS = {
    '1KI': { 20: 21, 21: 20 },
};

function mapJeremiah(mtCh, mtVerse) {
    for (const r of JEREMIAH_RANGES) {
        if (r.mtCh === mtCh && mtVerse >= r.mtFrom && mtVerse <= r.mtTo) {
            return { chapter: r.lxxCh, verse: r.lxxFrom + (mtVerse - r.mtFrom) };
        }
    }
    // Masoretic 26-44 sit at LXX 33-51, a straight +7 shift. NOT 45: that one
    // is appended to the end of LXX 51, and letting it shift would collide with
    // chapter 52, which the build catches as a double claim.
    if (mtCh >= 26 && mtCh <= 44) return { chapter: mtCh + 7, verse: mtVerse };
    // Masoretic 25:14 has no Greek counterpart — the oracle it introduces was
    // moved. Everything before it, and chapter 52, sit where they do in Hebrew.
    if (mtCh < 25 || (mtCh === 25 && mtVerse <= 13) || mtCh === 52) {
        return { chapter: mtCh, verse: mtVerse };
    }
    return null;                      // no counterpart in the Greek
}

// ── Psalms ────────────────────────────────────────────────────────────────
//
// 144 of 150 psalms are one-to-one with a constant verse offset, because the
// LXX counts the superscription as a verse (or two) where the Hebrew does not.
// That offset is DERIVED from the two verse counts rather than transcribed, so
// it is checkable rather than trusted.
//
// The remaining six are genuine joins and splits and are written out.
const PSALM_IRREGULAR = {
    // Masoretic -> LXX chapter, plus the verse shift within it.
    9: { lxxCh: 9, shift: 0 },                       // MT 9 + 10 are one psalm in the LXX
    10: { lxxCh: 9, shift: 20 },                     // continues after MT 9's 20 verses
    114: { lxxCh: 113, shift: 0 },                   // MT 114 + 115 are one psalm
    115: { lxxCh: 113, shift: 8 },                   // continues after MT 114's 8 verses
    116: { split: [{ upTo: 9, lxxCh: 114, shift: 0 }, { upTo: 19, lxxCh: 115, shift: -9 }] },
    147: { split: [{ upTo: 11, lxxCh: 146, shift: 0 }, { upTo: 20, lxxCh: 147, shift: -11 }] },
};

function psalmLxxChapter(mt) {
    if (mt <= 8) return mt;
    if (mt >= 11 && mt <= 113) return mt - 1;
    if (mt >= 117 && mt <= 146) return mt - 1;
    if (mt >= 148) return mt;
    return null;
}

// ── Text comparison, for verification only ────────────────────────────────

const STOP = new Set(('the and of to a in that is for my me i o shall will they he his him thou thy be with not all it their them from have as are was but which who unto upon into out by on at let us ye you our we this these those there then so shalt hath doth lord god said say unto').split(' '));

function contentWords(s) {
    return new Set(String(s ?? '').toLowerCase().replace(/\[|\]/g, ' ').replace(/[^a-z\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
}

function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let hit = 0;
    for (const w of a) if (b.has(w)) hit++;
    return hit / Math.min(a.size, b.size);
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SOURCE = args.find(a => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
const OUT = outFlag !== -1 ? args[outFlag + 1] : 'data/lxx.sqlite';
const BIBLE_DB = 'data/bible.db';

if (!SOURCE) {
    console.error('usage: node src/buildLxx.js <eng-Brenton_vpl.txt> [--out data/lxx.sqlite]');
    process.exit(1);
}

// Corroboration threshold. Deliberately low: Brenton translates the Greek and
// our BSB translates the Hebrew, so even a perfectly aligned verse shares only
// some vocabulary. This is a check for GROSS misalignment (a different psalm
// entirely), not for translation agreement.
const ALIGN_THRESHOLD = 0.18;

function parseSource(file) {
    const rows = [];
    let lineNo = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        lineNo++;
        if (!line.trim()) continue;
        const m = /^([0-9A-Z]{3})\s+(\d+):(\d+)\s+(.*)$/.exec(line);
        if (!m) {
            if (lineNo < 5) console.warn(`  skipped unparsed line ${lineNo}: ${line.slice(0, 60)}`);
            continue;
        }
        rows.push({ code: m[1], chapter: Number(m[2]), verse: Number(m[3]), text: m[4].trim() });
    }
    return rows;
}

function openDb(file, mode) {
    return new sqlite3.Database(file, mode);
}
const runOn = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const allOn = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

async function main() {
    console.log(`[LXX] Reading ${SOURCE}`);
    const rows = parseSource(SOURCE);
    console.log(`[LXX] Parsed ${rows.length} verses`);

    const codes = [...new Set(rows.map(r => r.code))];
    const unknown = codes.filter(c => !USFM_TO_CANONICAL[c] && !DEUTERO[c]);
    if (unknown.length) throw new Error(`Unrecognised book codes: ${unknown.join(', ')}`);

    for (const [code, canonical] of Object.entries(USFM_TO_CANONICAL)) {
        if (!canonicalToId.has(canonical)) throw new Error(`No bookId for "${canonical}" (code ${code})`);
    }

    // Verse counts per chapter, both sides — the Psalms offset falls out of these.
    const lxxMax = new Map();                       // "CODE c" -> max verse
    for (const r of rows) {
        const k = `${r.code} ${r.chapter}`;
        lxxMax.set(k, Math.max(lxxMax.get(k) ?? 0, r.verse));
    }

    const bible = openDb(BIBLE_DB, sqlite3.OPEN_READONLY);
    const mtRows = await allOn(bible, `SELECT bookID, chapter, verse, BSB, KJV FROM english`);
    const mtText = new Map();                       // "id c:v" -> text
    const mtMax = new Map();                        // "id c"   -> max verse
    for (const r of mtRows) {
        mtText.set(`${r.bookID} ${r.chapter}:${r.verse}`, r.BSB || r.KJV || '');
        const k = `${r.bookID} ${r.chapter}`;
        mtMax.set(k, Math.max(mtMax.get(k) ?? 0, r.verse));
    }
    bible.close();
    console.log(`[LXX] Loaded ${mtRows.length} Masoretic verses for verification`);

    // --- map every row to Masoretic coordinates where one exists -----------
    const out = [];
    const psalmOffsets = new Map();

    for (const r of rows) {
        const deut = DEUTERO[r.code];
        const canonical = USFM_TO_CANONICAL[r.code];
        const bookId = canonical ? canonicalToId.get(canonical) : null;
        const displayBook = deut ? deut.name : canonical;
        const canon = deut ? 'deutero' : 'protestant';
        out.push({
            code: r.code, lxxChapter: r.chapter, lxxVerse: r.verse, text: r.text,
            bookId: null, chapter: null, verse: null,
            displayBook, canon, approx: 0,
        });
    }

    // Index LXX rows for reverse assignment.
    const byLxx = new Map();
    for (const o of out) byLxx.set(`${o.code} ${o.lxxChapter}:${o.lxxVerse}`, o);

    // Where a reference points BEFORE any empirical correction. Structural
    // knowledge only: chapter rearrangements and the large shifts that join or
    // split psalms. Small per-chapter offsets are NOT guessed here — they are
    // derived below from the text itself.
    function baseTarget(code, mtCh, v, nVerses) {
        if (code === 'PSA') {
            const irr = PSALM_IRREGULAR[mtCh];
            if (irr?.split) {
                const seg = irr.split.find(s => v <= s.upTo);
                return seg ? { chapter: seg.lxxCh, verse: v + seg.shift } : null;
            }
            if (irr) return { chapter: irr.lxxCh, verse: v + irr.shift };
            const lxxCh = psalmLxxChapter(mtCh);
            return lxxCh === null ? null : { chapter: lxxCh, verse: v };
        }
        if (code === 'JER') return mapJeremiah(mtCh, v);
        const swapped = CHAPTER_SWAPS[code]?.[mtCh];
        return { chapter: swapped ?? mtCh, verse: v };
    }

    // THE CORRECTION PASS.
    //
    // Hebrew, Greek and English disagree about where chapters begin in a dozen
    // books — English Hosea 1:10 is Greek Hosea 2:1, English Joel 2:28 is Greek
    // Joel 3:1 — and the LXX counts psalm superscriptions the Hebrew leaves
    // unnumbered. Rather than transcribe every quirk (and get some wrong), each
    // chapter's offset is CHOSEN by seeing which one the text agrees with.
    //
    // A chapter keeps offset 0 unless another offset corroborates clearly
    // better, so the well-behaved majority is never perturbed. Verses that fall
    // off the end under the chosen offset simply go unmapped: an absent verse
    // is a far better outcome than a confidently wrong one.
    function scoreOffset(code, bookId, mtCh, nVerses, delta) {
        let n = 0, sum = 0;
        for (let v = 1; v <= nVerses; v++) {
            const base = baseTarget(code, mtCh, v, nVerses);
            if (!base) continue;
            const row = byLxx.get(`${code} ${base.chapter}:${base.verse + delta}`);
            const mt = mtText.get(`${bookId} ${mtCh}:${v}`);
            if (!row || !mt) continue;
            sum += overlap(contentWords(mt), contentWords(row.text));
            n++;
        }
        return { mean: n ? sum / n : 0, matched: n };
    }

    const chosenOffset = new Map();          // "code ch" -> delta
    for (const [code, canonical] of Object.entries(USFM_TO_CANONICAL)) {
        const bookId = canonicalToId.get(canonical);
        const chapters = [...mtMax.keys()].filter(k => k.startsWith(`${bookId} `))
            .map(k => Number(k.split(' ')[1])).sort((a, b) => a - b);

        for (const mtCh of chapters) {
            const nVerses = mtMax.get(`${bookId} ${mtCh}`);
            const zero = scoreOffset(code, bookId, mtCh, nVerses, 0);
            let best = { delta: 0, ...zero };
            if (zero.mean < ALIGN_THRESHOLD * 1.5) {
                for (const delta of [1, -1, 2, -2, 3, -3, 4, -4]) {
                    const s = scoreOffset(code, bookId, mtCh, nVerses, delta);
                    // Must beat the incumbent decisively AND still cover most
                    // of the chapter, so a single lucky verse cannot win.
                    if (s.mean > best.mean + 0.08 && s.matched >= Math.min(4, nVerses) && s.matched >= zero.matched * 0.6) {
                        best = { delta, ...s };
                    }
                }
            }
            if (best.delta !== 0) {
                chosenOffset.set(`${code} ${mtCh}`, best.delta);
                console.log(`   [offset] ${canonical} ${mtCh}: ${best.delta > 0 ? '+' : ''}${best.delta} (${zero.mean.toFixed(2)} -> ${best.mean.toFixed(2)})`);
            }
        }
    }

    // Walk the MASORETIC side and claim the LXX row each reference points at.
    // Driving from the Masoretic side is what guarantees the coordinates we
    // store are exactly the ones a user can ask for.
    let mapped = 0, unmatched = 0;
    for (const [code, canonical] of Object.entries(USFM_TO_CANONICAL)) {
        const bookId = canonicalToId.get(canonical);
        const chapters = [...mtMax.keys()].filter(k => k.startsWith(`${bookId} `))
            .map(k => Number(k.split(' ')[1])).sort((a, b) => a - b);

        for (const mtCh of chapters) {
            const nVerses = mtMax.get(`${bookId} ${mtCh}`);
            const delta = chosenOffset.get(`${code} ${mtCh}`) ?? 0;
            for (let v = 1; v <= nVerses; v++) {
                const base = baseTarget(code, mtCh, v, nVerses);
                if (!base) { unmatched++; continue; }
                const row = byLxx.get(`${code} ${base.chapter}:${base.verse + delta}`);
                if (!row) { unmatched++; continue; }
                // First claim wins; a second Masoretic verse pointing at the
                // same Greek verse means the map is wrong, so say so.
                if (row.bookId !== null) {
                    console.warn(`  [warn] ${code} ${base.chapter}:${base.verse + delta} claimed twice (${row.chapter}:${row.verse} and ${mtCh}:${v})`);
                    continue;
                }
                row.bookId = bookId;
                row.chapter = mtCh;
                row.verse = v;
                mapped++;
            }
        }
    }

    console.log(`[LXX] Mapped ${mapped} verses to Masoretic coordinates (${unmatched} Masoretic verses have no Greek counterpart)`);

    // --- verify, per book, against the Masoretic English -------------------
    console.log('\n[LXX] Verification (lexical corroboration vs BSB):');
    const perBook = new Map();
    for (const o of out) {
        if (o.bookId === null) continue;
        const mt = mtText.get(`${o.bookId} ${o.chapter}:${o.verse}`);
        if (!mt) continue;
        const score = overlap(contentWords(mt), contentWords(o.text));
        const key = `${o.bookId}|${o.displayBook}`;
        if (!perBook.has(key)) perBook.set(key, { n: 0, sum: 0, low: 0, chapters: new Map() });
        const agg = perBook.get(key);
        agg.n++; agg.sum += score;
        if (score < ALIGN_THRESHOLD) agg.low++;
        const ch = agg.chapters.get(o.chapter) ?? { n: 0, sum: 0 };
        ch.n++; ch.sum += score;
        agg.chapters.set(o.chapter, ch);
    }

    const suspect = [];
    for (const [key, agg] of [...perBook].sort((a, b) => (a[1].sum / a[1].n) - (b[1].sum / b[1].n))) {
        const [, name] = key.split('|');
        const mean = agg.sum / agg.n;
        const flagged = [];
        for (const [ch, s] of agg.chapters) {
            if (s.n >= 4 && s.sum / s.n < ALIGN_THRESHOLD * 0.6) flagged.push(ch);
        }
        if (flagged.length) suspect.push({ name, chapters: flagged });
        const bar = mean < ALIGN_THRESHOLD ? '  <-- LOW' : '';
        console.log(`   ${name.padEnd(18)} mean ${mean.toFixed(3)}  n=${String(agg.n).padStart(5)}  weak chapters: ${flagged.length}${bar}`);
    }

    // Mark rows in poorly-corroborated chapters as approximate rather than
    // dropping them: the reader still gets the text, and the card can say the
    // numbering may not line up.
    const suspectSet = new Set();
    for (const s of suspect) for (const ch of s.chapters) suspectSet.add(`${s.name} ${ch}`);
    let approxCount = 0;
    for (const o of out) {
        if (o.bookId !== null && suspectSet.has(`${o.displayBook} ${o.chapter}`)) {
            o.approx = 1; approxCount++;
        }
    }
    if (suspect.length) {
        console.log(`\n[LXX] ${approxCount} verses in ${suspectSet.size} chapters marked approx=1:`);
        for (const s of suspect) console.log(`   ${s.name}: ${s.chapters.join(', ')}`);
    }

    // --- write -------------------------------------------------------------
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
    const db = openDb(OUT, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

    await runOn(db, `CREATE TABLE lxx (
        book_id     INTEGER,
        chapter     INTEGER,
        verse       INTEGER,
        lxx_book    TEXT    NOT NULL,
        lxx_chapter INTEGER NOT NULL,
        lxx_verse   INTEGER NOT NULL,
        lxx_ref     TEXT    NOT NULL,
        display_book TEXT   NOT NULL,
        canon       TEXT    NOT NULL,
        approx      INTEGER NOT NULL DEFAULT 0,
        text        TEXT    NOT NULL
    )`);
    await runOn(db, `CREATE TABLE lxx_books (
        code    TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        canon   TEXT NOT NULL,
        book_id INTEGER
    )`);
    await runOn(db, `CREATE TABLE lxx_alias (alias TEXT PRIMARY KEY, code TEXT NOT NULL)`);

    await runOn(db, 'BEGIN');
    const stmt = db.prepare(`INSERT INTO lxx
        (book_id, chapter, verse, lxx_book, lxx_chapter, lxx_verse, lxx_ref, display_book, canon, approx, text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const o of out) {
        const ref = `LXX ${o.displayBook} ${o.lxxChapter}:${o.lxxVerse}`;
        stmt.run([o.bookId, o.chapter, o.verse, o.code, o.lxxChapter, o.lxxVerse, ref, o.displayBook, o.canon, o.approx, o.text]);
    }
    await new Promise((res, rej) => stmt.finalize(e => e ? rej(e) : res()));

    for (const [code, canonical] of Object.entries(USFM_TO_CANONICAL)) {
        await runOn(db, `INSERT INTO lxx_books (code, name, canon, book_id) VALUES (?,?,?,?)`,
            [code, canonical, 'protestant', canonicalToId.get(canonical)]);
    }
    for (const [code, meta] of Object.entries(DEUTERO)) {
        await runOn(db, `INSERT INTO lxx_books (code, name, canon, book_id) VALUES (?,?,?,?)`,
            [code, meta.name, 'deutero', null]);
        for (const alias of meta.aliases) {
            await runOn(db, `INSERT OR REPLACE INTO lxx_alias (alias, code) VALUES (?,?)`, [alias, code]);
        }
    }

    await runOn(db, `CREATE INDEX idx_lxx_mt ON lxx (book_id, chapter, verse)`);
    await runOn(db, `CREATE INDEX idx_lxx_native ON lxx (lxx_book, lxx_chapter, lxx_verse)`);
    await runOn(db, 'COMMIT');
    await new Promise(res => db.close(res));

    const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
    console.log(`\n[LXX] Wrote ${OUT} (${size} MB, ${out.length} verses)`);
}

main().catch(err => {
    console.error(`[LXX] Build failed: ${err.message}`);
    process.exit(1);
});
