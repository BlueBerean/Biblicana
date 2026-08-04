// Snapshot + round-trip coverage for src/utils/bookNames.js.
// The six concurrent Bible-book naming conventions in the codebase make this
// the highest-bug-density area — one wrong row here breaks /commentary,
// /crossref, /fathers, /topicalindex, or /find silently. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

// Silence the expected "no match" warnings from getBookId(invalid) cases.
log.setLevel('error');

import {
    BOOKS,
    numbersToBook,
    bookAbbreviations,
    getBookId,
    toCanonical,
    toTSKSource,
    toOSIS3Codes,
    fromOSIS3Code,
    toCommentaryVariants,
} from '../src/utils/bookNames.js';

// The AI-prompt abbreviation list baked into src/commands/find.js — kept here
// literally so a drift between the prompt and BOOKS.shortCode trips the test.
const FIND_PROMPT_CODES = [
    'gen', 'exo', 'lev', 'num', 'deu', 'jos', 'jdg', 'rut', '1sa', '2sa',
    '1ki', '2ki', '1ch', '2ch', 'ezr', 'neh', 'est', 'job', 'psa', 'pro',
    'ecc', 'sos', 'isa', 'jer', 'lam', 'eze', 'dan', 'hos', 'joe', 'amo',
    'oba', 'jon', 'mic', 'nah', 'hab', 'zep', 'hag', 'zec', 'mal', 'mat',
    'mar', 'luk', 'joh', 'act', 'rom', '1co', '2co', 'gal', 'eph', 'php',
    'col', '1th', '2th', '1ti', '2ti', 'tit', 'phm', 'heb', 'jam', '1pe',
    '2pe', '1jo', '2jo', '3jo', 'jde', 'rev',
];

test('BOOKS has 66 entries with sequential ids 1..66', () => {
    assert.equal(BOOKS.length, 66);
    BOOKS.forEach((b, i) => {
        assert.equal(b.id, i + 1, `entry at index ${i} has wrong id`);
    });
});

test('every BOOKS row has required fields with correct shape', () => {
    for (const b of BOOKS) {
        assert.ok(typeof b.canonical === 'string' && b.canonical.length > 0, `${b.id} canonical`);
        assert.ok(typeof b.osis3 === 'string' && b.osis3.length === 3, `${b.id} osis3`);
        assert.ok(b.osis3Alt === null || typeof b.osis3Alt === 'string', `${b.id} osis3Alt`);
        assert.ok(typeof b.tskSource === 'string' && b.tskSource.length > 0, `${b.id} tskSource`);
        assert.ok(Array.isArray(b.compactVariants) && b.compactVariants.length >= 1, `${b.id} compactVariants`);
        assert.ok(typeof b.shortCode === 'string' && b.shortCode.length >= 2 && b.shortCode.length <= 3, `${b.id} shortCode`);
    }
});

test('numbersToBook Map matches BOOKS.canonical for every id', () => {
    assert.equal(numbersToBook.size, 66);
    for (const b of BOOKS) {
        assert.equal(numbersToBook.get(b.id), b.canonical);
    }
});

test('bookAbbreviations Map matches BOOKS.shortCode for every id', () => {
    assert.equal(bookAbbreviations.size, 66);
    for (const b of BOOKS) {
        assert.equal(bookAbbreviations.get(b.shortCode), b.id);
    }
});

test('canonical -> id -> canonical round-trips for all 66 books', () => {
    for (const b of BOOKS) {
        const id = getBookId(b.canonical);
        assert.equal(id, b.id, `getBookId("${b.canonical}")`);
        assert.equal(toCanonical(id), b.canonical, `toCanonical(${id})`);
    }
});

test('every shortCode resolves via getBookId and via bookAbbreviations', () => {
    for (const b of BOOKS) {
        assert.equal(getBookId(b.shortCode), b.id, `getBookId("${b.shortCode}")`);
        assert.equal(bookAbbreviations.get(b.shortCode), b.id, `bookAbbreviations("${b.shortCode}")`);
    }
});

test('OSIS3 primary codes all round-trip', () => {
    for (const b of BOOKS) {
        assert.equal(fromOSIS3Code(b.osis3), b.id, `fromOSIS3Code("${b.osis3}")`);
        assert.ok(toOSIS3Codes(b.id).includes(b.osis3), `toOSIS3Codes(${b.id})`);
    }
});

test('OSIS3 alt codes round-trip for the 4 books that have them', () => {
    const booksWithAlt = BOOKS.filter(b => b.osis3Alt);
    assert.equal(booksWithAlt.length, 4, 'expected exactly 4 books with alt codes');
    for (const b of booksWithAlt) {
        assert.equal(fromOSIS3Code(b.osis3Alt), b.id, `fromOSIS3Code("${b.osis3Alt}")`);
        const codes = toOSIS3Codes(b.id);
        assert.equal(codes.length, 2, `toOSIS3Codes(${b.id}) should have 2 entries`);
        assert.ok(codes.includes(b.osis3), `primary in codes for ${b.id}`);
        assert.ok(codes.includes(b.osis3Alt), `alt in codes for ${b.id}`);
    }
});

test('toTSKSource returns tskSource column for every canonical name', () => {
    for (const b of BOOKS) {
        assert.equal(toTSKSource(b.canonical), b.tskSource, `toTSKSource("${b.canonical}")`);
    }
});

test('toTSKSource flips Arabic numerals to Roman where required', () => {
    const romanExpected = {
        '1 Samuel': 'I Samuel',
        '2 Samuel': 'II Samuel',
        '1 Kings': 'I Kings',
        '2 Kings': 'II Kings',
        '1 Chronicles': 'I Chronicles',
        '2 Chronicles': 'II Chronicles',
        '1 Corinthians': 'I Corinthians',
        '2 Corinthians': 'II Corinthians',
        '1 Thessalonians': 'I Thessalonians',
        '2 Thessalonians': 'II Thessalonians',
        '1 Timothy': 'I Timothy',
        '2 Timothy': 'II Timothy',
        '1 Peter': 'I Peter',
        '2 Peter': 'II Peter',
        '1 John': 'I John',
        '2 John': 'II John',
        '3 John': 'III John',
        'Revelation': 'Revelation of John',
    };
    for (const [input, expected] of Object.entries(romanExpected)) {
        assert.equal(toTSKSource(input), expected);
    }
});

test('toCommentaryVariants returns compactVariants array for every canonical', () => {
    for (const b of BOOKS) {
        assert.deepEqual(toCommentaryVariants(b.canonical), b.compactVariants, b.canonical);
    }
});

test('Psalms commentaryVariants contains both ["psalms", "psalm"]', () => {
    assert.deepEqual(toCommentaryVariants('Psalms'), ['psalms', 'psalm']);
});

test('all 66 AI-prompt shortCodes in find.js resolve to a bookId', () => {
    // If this drifts, the OpenAI response from /find will produce unresolved
    // references and empty embeds. The test anchors the prompt to BOOKS.
    assert.equal(FIND_PROMPT_CODES.length, 66);
    FIND_PROMPT_CODES.forEach((code, idx) => {
        const expectedId = idx + 1;
        assert.equal(bookAbbreviations.get(code), expectedId, `${code} → ${expectedId}`);
    });
});

test('common typos and variant spellings resolve correctly', () => {
    assert.equal(getBookId('Revelation'), 66);
    assert.equal(getBookId('revelations'), 66);  // plural misspelling
    assert.equal(getBookId('revalation'), 66);   // common typo
    assert.equal(getBookId('Song of Songs'), 22);
    assert.equal(getBookId('songofsongs'), 22);
    assert.equal(getBookId('I Samuel'), 9);
    assert.equal(getBookId('first peter'), 60);
    assert.equal(getBookId('1 sam'), 9);
    assert.equal(getBookId('  1SA '), 9);        // whitespace + case
});

test('Roman-numeral prefix normalization resolves all numbered books', () => {
    // Regression guard: the Roman→Arabic prefix normalizer should let every
    // "I/II/III <book>" input resolve the same as "1/2/3 <book>" — LEGACY_ALIASES
    // historically had Roman entries for Samuel/Kings/Peter but not for the
    // other numbered books.
    assert.equal(getBookId('I John'), 62);
    assert.equal(getBookId('II John'), 63);
    assert.equal(getBookId('III John'), 64);
    assert.equal(getBookId('I Corinthians'), 46);
    assert.equal(getBookId('II Corinthians'), 47);
    assert.equal(getBookId('I Chronicles'), 13);
    assert.equal(getBookId('II Chronicles'), 14);
    assert.equal(getBookId('I Thessalonians'), 52);
    assert.equal(getBookId('II Thessalonians'), 53);
    assert.equal(getBookId('I Timothy'), 54);
    assert.equal(getBookId('II Timothy'), 55);
});

test('Roman-numeral normalization does not eat "Isaiah" / "Ichabod"-style words', () => {
    // The regex requires whitespace after the I's. Single-token book names
    // starting with "I" must not be confused with Roman numerals.
    assert.equal(getBookId('Isaiah'), 23);
    assert.equal(getBookId('isaiah'), 23);
    assert.equal(getBookId('Isa'), 23);
});

test('getBookId returns null on invalid input rather than a bad default', () => {
    assert.equal(getBookId(null), null);
    assert.equal(getBookId(undefined), null);
    assert.equal(getBookId(''), null);
    assert.equal(getBookId('notabook'), null);
});

test('canonical names, shortCodes, and OSIS3 codes are all unique', () => {
    const canonicals = new Set();
    const shortCodes = new Set();
    const osis3Set = new Set();
    for (const b of BOOKS) {
        assert.ok(!canonicals.has(b.canonical), `duplicate canonical: ${b.canonical}`);
        assert.ok(!shortCodes.has(b.shortCode), `duplicate shortCode: ${b.shortCode}`);
        assert.ok(!osis3Set.has(b.osis3), `duplicate osis3: ${b.osis3}`);
        canonicals.add(b.canonical);
        shortCodes.add(b.shortCode);
        osis3Set.add(b.osis3);
    }
});

// ── Prod-log-driven resolution gaps (2026-06-18 error-log review) ───────────

test('standard abbreviations seen failing in prod now resolve', () => {
    assert.equal(getBookId('ex'), 2);      // Exodus
    assert.equal(getBookId('deut'), 5);    // Deuteronomy
    assert.equal(getBookId('mt'), 40);     // Matthew
    assert.equal(getBookId('phi'), 50);    // Philippians
    assert.equal(getBookId('roman'), 45);  // Romans (missing trailing s)
});

test('common book-name misspellings resolve', () => {
    for (const w of ['mathew', 'mattew', 'mathhew']) assert.equal(getBookId(w), 40, w);
    for (const w of ['phillipians', 'phillipans', 'philipians']) assert.equal(getBookId(w), 50, w);
});

test('observed non-English book names resolve', () => {
    assert.equal(getBookId('salmos'), 19);  // Psalms (Spanish)
    assert.equal(getBookId('Salmos'), 19);  // case-insensitive
    assert.equal(getBookId('tite'), 56);    // Titus (French)
});

test('book name with chapter number stuck on the end resolves (digit split)', () => {
    assert.equal(getBookId('salmos91'), 19);   // salmos + 91
    assert.equal(getBookId('proverbs6'), 20);  // proverbs + 6
    assert.equal(getBookId('genesis1'), 1);    // canonical + digit
    // Must not mis-split a numbered-book shortCode that has no trailing digit.
    assert.equal(getBookId('1sa'), 9);
});

test('lenient aliases resolve for direct user input (slash command path)', () => {
    assert.equal(getBookId('is'), 23);             // Isaiah
    assert.equal(getBookId('corinthians'), 46);    // ambiguous → 1 Corinthians
    assert.equal(getBookId('samuel'), 9);          // ambiguous → 1 Samuel
    assert.equal(getBookId('thessalonians'), 52);  // ambiguous → 1 Thessalonians
    assert.equal(getBookId('peter'), 60);          // ambiguous → 1 Peter
    assert.equal(getBookId('timothy'), 54);        // ambiguous → 1 Timothy
});

test('lenient aliases are REJECTED on the silent passive-detection path', () => {
    // Critical guard: the scripture-ref scanner calls getBookId(word, {silent:true})
    // on every "Word <number>" in a message. If "is" resolved here, "the answer
    // is 5" would be detected as "Isaiah 5". These must stay unresolved.
    assert.equal(getBookId('is', { silent: true }), null);
    assert.equal(getBookId('corinthians', { silent: true }), null);
    assert.equal(getBookId('samuel', { silent: true }), null);
    assert.equal(getBookId('peter', { silent: true }), null);
    assert.equal(getBookId('timothy', { silent: true }), null);
});

test('safe aliases STILL resolve on the silent path (good for passive detection)', () => {
    // Non-English-word abbreviations/typos are fine to match passively — a Bible
    // bot reacting to "Mt 5" or "Salmos 91" in chat is the intended behavior.
    assert.equal(getBookId('mt', { silent: true }), 40);
    assert.equal(getBookId('phi', { silent: true }), 50);
    assert.equal(getBookId('salmos', { silent: true }), 19);
    assert.equal(getBookId('mathew', { silent: true }), 40);
    assert.equal(getBookId('roman', { silent: true }), 45);
});

test('genuinely-unsupported inputs still return null (no false default)', () => {
    assert.equal(getBookId('bible'), null);        // user confusion, not a book
    assert.equal(getBookId('holybible'), null);
    assert.equal(getBookId('sirach'), null);       // apocrypha, not in 66-book canon
    assert.equal(getBookId('wisdom'), null);       // apocrypha
});

// --- Second wave of prod misspellings (FUZZY_TYPOS) ------------------------
// Always-on, including the silent passive path: none of these are English
// words, so they cannot produce false positives on ordinary chat.

test('second-wave typos resolve on the slash path', () => {
    assert.equal(getBookId('galations'), 48);
    assert.equal(getBookId('pslams'), 19);
    assert.equal(getBookId('pslam'), 19);
    assert.equal(getBookId('gensis'), 1);
    assert.equal(getBookId('genises'), 1);
    assert.equal(getBookId('ecclesiates'), 21);
    assert.equal(getBookId('dueteronomy'), 5);
    assert.equal(getBookId('lukas'), 42);
    assert.equal(getBookId('bookofisiah'), 23);
});

test('all three Zechariah misspellings collapse to one book', () => {
    assert.equal(getBookId('zacariah'), 38);
    assert.equal(getBookId('zachariah'), 38);
    assert.equal(getBookId('zecheriah'), 38);
});

test('second-wave typos also resolve on the SILENT path', () => {
    // Deliberate: these are not English words, so passive detection can safely
    // pick them up out of chat messages.
    assert.equal(getBookId('galations', { silent: true }), 48);
    assert.equal(getBookId('pslams', { silent: true }), 19);
    assert.equal(getBookId('dueteronomy', { silent: true }), 5);
});

// --- Ambiguous bare names (LENIENT_ALIASES) -------------------------------

test('kings and chronicles default to the first book, matching samuel', () => {
    assert.equal(getBookId('kings'), 11);         // 1 Kings
    assert.equal(getBookId('chronicles'), 13);    // 1 Chronicles
    assert.equal(getBookId('samuel'), 9);         // pre-existing, same class
});

test('ambiguous bare names stay REJECTED on the silent path', () => {
    // This is the safety property that keeps passive detection from turning
    // "the kings of Israel" in chat into a 1 Kings lookup. If this ever starts
    // returning a bookId, the passive scanner will begin false-positiving on
    // ordinary English.
    assert.equal(getBookId('kings', { silent: true }), null);
    assert.equal(getBookId('chronicles', { silent: true }), null);
    assert.equal(getBookId('samuel', { silent: true }), null);
});

test('john was already resolvable and is NOT treated as ambiguous', () => {
    // Listed in FOLLOWUPS alongside kings/chronicles, but unlike those it
    // already resolved via the main book table on BOTH paths — the Gospel is
    // the unmarked reading of a bare "John". No lenient entry was added.
    assert.equal(getBookId('john'), 43);
    assert.equal(getBookId('john', { silent: true }), 43);
});
