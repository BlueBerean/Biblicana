import logger from './logger.js';

// Single source of truth for Bible book naming across the codebase's six
// data sources. All projection functions derive from the BOOKS table —
// adding a seventh naming convention means adding one column here.
//
//   canonical       — "Genesis"              (UI display; numbersToBook shape)
//   osis3           — "GEN"                  (clean_commentary.db, primary)
//   osis3Alt        — "Ezek" or null         (clean_commentary.db, mixed-case
//                                             alternate used by one commentator
//                                             for 4 books)
//   tskSource       — "Genesis" | "I Samuel" (cross-references.source_book —
//                                             17 books use Roman numerals)
//   compactVariants — ["genesis"]            (extrabiblical_data.sqlite — Psalms
//                                             is the only book with two
//                                             variants, ["psalms", "psalm"])
//   shortCode       — "gen"                  (/find's AI prompt convention)
export const BOOKS = [
    { id: 1,  canonical: 'Genesis',         osis3: 'GEN', osis3Alt: null,   tskSource: 'Genesis',            compactVariants: ['genesis'],         shortCode: 'gen' },
    { id: 2,  canonical: 'Exodus',          osis3: 'EXO', osis3Alt: null,   tskSource: 'Exodus',             compactVariants: ['exodus'],          shortCode: 'exo' },
    { id: 3,  canonical: 'Leviticus',       osis3: 'LEV', osis3Alt: null,   tskSource: 'Leviticus',          compactVariants: ['leviticus'],       shortCode: 'lev' },
    { id: 4,  canonical: 'Numbers',         osis3: 'NUM', osis3Alt: null,   tskSource: 'Numbers',            compactVariants: ['numbers'],         shortCode: 'num' },
    { id: 5,  canonical: 'Deuteronomy',     osis3: 'DEU', osis3Alt: null,   tskSource: 'Deuteronomy',        compactVariants: ['deuteronomy'],     shortCode: 'deu' },
    { id: 6,  canonical: 'Joshua',          osis3: 'JOS', osis3Alt: null,   tskSource: 'Joshua',             compactVariants: ['joshua'],          shortCode: 'jos' },
    { id: 7,  canonical: 'Judges',          osis3: 'JDG', osis3Alt: null,   tskSource: 'Judges',             compactVariants: ['judges'],          shortCode: 'jdg' },
    { id: 8,  canonical: 'Ruth',            osis3: 'RUT', osis3Alt: null,   tskSource: 'Ruth',               compactVariants: ['ruth'],            shortCode: 'rut' },
    { id: 9,  canonical: '1 Samuel',        osis3: '1SA', osis3Alt: null,   tskSource: 'I Samuel',           compactVariants: ['1samuel'],         shortCode: '1sa' },
    { id: 10, canonical: '2 Samuel',        osis3: '2SA', osis3Alt: null,   tskSource: 'II Samuel',          compactVariants: ['2samuel'],         shortCode: '2sa' },
    { id: 11, canonical: '1 Kings',         osis3: '1KI', osis3Alt: null,   tskSource: 'I Kings',            compactVariants: ['1kings'],          shortCode: '1ki' },
    { id: 12, canonical: '2 Kings',         osis3: '2KI', osis3Alt: null,   tskSource: 'II Kings',           compactVariants: ['2kings'],          shortCode: '2ki' },
    { id: 13, canonical: '1 Chronicles',    osis3: '1CH', osis3Alt: null,   tskSource: 'I Chronicles',       compactVariants: ['1chronicles'],     shortCode: '1ch' },
    { id: 14, canonical: '2 Chronicles',    osis3: '2CH', osis3Alt: null,   tskSource: 'II Chronicles',      compactVariants: ['2chronicles'],     shortCode: '2ch' },
    { id: 15, canonical: 'Ezra',            osis3: 'EZR', osis3Alt: null,   tskSource: 'Ezra',               compactVariants: ['ezra'],            shortCode: 'ezr' },
    { id: 16, canonical: 'Nehemiah',        osis3: 'NEH', osis3Alt: null,   tskSource: 'Nehemiah',           compactVariants: ['nehemiah'],        shortCode: 'neh' },
    { id: 17, canonical: 'Esther',          osis3: 'EST', osis3Alt: null,   tskSource: 'Esther',             compactVariants: ['esther'],          shortCode: 'est' },
    { id: 18, canonical: 'Job',             osis3: 'JOB', osis3Alt: null,   tskSource: 'Job',                compactVariants: ['job'],             shortCode: 'job' },
    { id: 19, canonical: 'Psalms',          osis3: 'PSA', osis3Alt: null,   tskSource: 'Psalms',             compactVariants: ['psalms', 'psalm'], shortCode: 'psa' },
    { id: 20, canonical: 'Proverbs',        osis3: 'PRO', osis3Alt: null,   tskSource: 'Proverbs',           compactVariants: ['proverbs'],        shortCode: 'pro' },
    { id: 21, canonical: 'Ecclesiastes',    osis3: 'ECC', osis3Alt: null,   tskSource: 'Ecclesiastes',       compactVariants: ['ecclesiastes'],    shortCode: 'ecc' },
    { id: 22, canonical: 'Song of Solomon', osis3: 'SNG', osis3Alt: null,   tskSource: 'Song of Solomon',    compactVariants: ['songofsolomon'],   shortCode: 'sos' },
    { id: 23, canonical: 'Isaiah',          osis3: 'ISA', osis3Alt: null,   tskSource: 'Isaiah',             compactVariants: ['isaiah'],          shortCode: 'isa' },
    { id: 24, canonical: 'Jeremiah',        osis3: 'JER', osis3Alt: null,   tskSource: 'Jeremiah',           compactVariants: ['jeremiah'],        shortCode: 'jer' },
    { id: 25, canonical: 'Lamentations',    osis3: 'LAM', osis3Alt: null,   tskSource: 'Lamentations',       compactVariants: ['lamentations'],    shortCode: 'lam' },
    { id: 26, canonical: 'Ezekiel',         osis3: 'EZK', osis3Alt: 'Ezek', tskSource: 'Ezekiel',            compactVariants: ['ezekiel'],         shortCode: 'eze' },
    { id: 27, canonical: 'Daniel',          osis3: 'DAN', osis3Alt: null,   tskSource: 'Daniel',             compactVariants: ['daniel'],          shortCode: 'dan' },
    { id: 28, canonical: 'Hosea',           osis3: 'HOS', osis3Alt: null,   tskSource: 'Hosea',              compactVariants: ['hosea'],           shortCode: 'hos' },
    { id: 29, canonical: 'Joel',            osis3: 'JOL', osis3Alt: null,   tskSource: 'Joel',               compactVariants: ['joel'],            shortCode: 'joe' },
    { id: 30, canonical: 'Amos',            osis3: 'AMO', osis3Alt: null,   tskSource: 'Amos',               compactVariants: ['amos'],            shortCode: 'amo' },
    { id: 31, canonical: 'Obadiah',         osis3: 'OBA', osis3Alt: null,   tskSource: 'Obadiah',            compactVariants: ['obadiah'],         shortCode: 'oba' },
    { id: 32, canonical: 'Jonah',           osis3: 'JON', osis3Alt: null,   tskSource: 'Jonah',              compactVariants: ['jonah'],           shortCode: 'jon' },
    { id: 33, canonical: 'Micah',           osis3: 'MIC', osis3Alt: null,   tskSource: 'Micah',              compactVariants: ['micah'],           shortCode: 'mic' },
    { id: 34, canonical: 'Nahum',           osis3: 'NAM', osis3Alt: 'Nah',  tskSource: 'Nahum',              compactVariants: ['nahum'],           shortCode: 'nah' },
    { id: 35, canonical: 'Habakkuk',        osis3: 'HAB', osis3Alt: null,   tskSource: 'Habakkuk',           compactVariants: ['habakkuk'],        shortCode: 'hab' },
    { id: 36, canonical: 'Zephaniah',       osis3: 'ZEP', osis3Alt: null,   tskSource: 'Zephaniah',          compactVariants: ['zephaniah'],       shortCode: 'zep' },
    { id: 37, canonical: 'Haggai',          osis3: 'HAG', osis3Alt: null,   tskSource: 'Haggai',             compactVariants: ['haggai'],          shortCode: 'hag' },
    { id: 38, canonical: 'Zechariah',       osis3: 'ZEC', osis3Alt: null,   tskSource: 'Zechariah',          compactVariants: ['zechariah'],       shortCode: 'zec' },
    { id: 39, canonical: 'Malachi',         osis3: 'MAL', osis3Alt: null,   tskSource: 'Malachi',            compactVariants: ['malachi'],         shortCode: 'mal' },
    { id: 40, canonical: 'Matthew',         osis3: 'MAT', osis3Alt: null,   tskSource: 'Matthew',            compactVariants: ['matthew'],         shortCode: 'mat' },
    { id: 41, canonical: 'Mark',            osis3: 'MRK', osis3Alt: null,   tskSource: 'Mark',               compactVariants: ['mark'],            shortCode: 'mar' },
    { id: 42, canonical: 'Luke',            osis3: 'LUK', osis3Alt: null,   tskSource: 'Luke',               compactVariants: ['luke'],            shortCode: 'luk' },
    { id: 43, canonical: 'John',            osis3: 'JHN', osis3Alt: null,   tskSource: 'John',               compactVariants: ['john'],            shortCode: 'joh' },
    { id: 44, canonical: 'Acts',            osis3: 'ACT', osis3Alt: null,   tskSource: 'Acts',               compactVariants: ['acts'],            shortCode: 'act' },
    { id: 45, canonical: 'Romans',          osis3: 'ROM', osis3Alt: null,   tskSource: 'Romans',             compactVariants: ['romans'],          shortCode: 'rom' },
    { id: 46, canonical: '1 Corinthians',   osis3: '1CO', osis3Alt: null,   tskSource: 'I Corinthians',      compactVariants: ['1corinthians'],    shortCode: '1co' },
    { id: 47, canonical: '2 Corinthians',   osis3: '2CO', osis3Alt: null,   tskSource: 'II Corinthians',     compactVariants: ['2corinthians'],    shortCode: '2co' },
    { id: 48, canonical: 'Galatians',       osis3: 'GAL', osis3Alt: null,   tskSource: 'Galatians',          compactVariants: ['galatians'],       shortCode: 'gal' },
    { id: 49, canonical: 'Ephesians',       osis3: 'EPH', osis3Alt: null,   tskSource: 'Ephesians',          compactVariants: ['ephesians'],       shortCode: 'eph' },
    { id: 50, canonical: 'Philippians',     osis3: 'PHP', osis3Alt: 'Phil', tskSource: 'Philippians',        compactVariants: ['philippians'],     shortCode: 'php' },
    { id: 51, canonical: 'Colossians',      osis3: 'COL', osis3Alt: null,   tskSource: 'Colossians',         compactVariants: ['colossians'],      shortCode: 'col' },
    { id: 52, canonical: '1 Thessalonians', osis3: '1TH', osis3Alt: null,   tskSource: 'I Thessalonians',    compactVariants: ['1thessalonians'],  shortCode: '1th' },
    { id: 53, canonical: '2 Thessalonians', osis3: '2TH', osis3Alt: null,   tskSource: 'II Thessalonians',   compactVariants: ['2thessalonians'],  shortCode: '2th' },
    { id: 54, canonical: '1 Timothy',       osis3: '1TI', osis3Alt: null,   tskSource: 'I Timothy',          compactVariants: ['1timothy'],        shortCode: '1ti' },
    { id: 55, canonical: '2 Timothy',       osis3: '2TI', osis3Alt: null,   tskSource: 'II Timothy',         compactVariants: ['2timothy'],        shortCode: '2ti' },
    { id: 56, canonical: 'Titus',           osis3: 'TIT', osis3Alt: null,   tskSource: 'Titus',              compactVariants: ['titus'],           shortCode: 'tit' },
    { id: 57, canonical: 'Philemon',        osis3: 'PHM', osis3Alt: 'Phlm', tskSource: 'Philemon',           compactVariants: ['philemon'],        shortCode: 'phm' },
    { id: 58, canonical: 'Hebrews',         osis3: 'HEB', osis3Alt: null,   tskSource: 'Hebrews',            compactVariants: ['hebrews'],         shortCode: 'heb' },
    { id: 59, canonical: 'James',           osis3: 'JAS', osis3Alt: null,   tskSource: 'James',              compactVariants: ['james'],           shortCode: 'jam' },
    { id: 60, canonical: '1 Peter',         osis3: '1PE', osis3Alt: null,   tskSource: 'I Peter',            compactVariants: ['1peter'],          shortCode: '1pe' },
    { id: 61, canonical: '2 Peter',         osis3: '2PE', osis3Alt: null,   tskSource: 'II Peter',           compactVariants: ['2peter'],          shortCode: '2pe' },
    { id: 62, canonical: '1 John',          osis3: '1JN', osis3Alt: null,   tskSource: 'I John',             compactVariants: ['1john'],           shortCode: '1jo' },
    { id: 63, canonical: '2 John',          osis3: '2JN', osis3Alt: null,   tskSource: 'II John',            compactVariants: ['2john'],           shortCode: '2jo' },
    { id: 64, canonical: '3 John',          osis3: '3JN', osis3Alt: null,   tskSource: 'III John',           compactVariants: ['3john'],           shortCode: '3jo' },
    { id: 65, canonical: 'Jude',            osis3: 'JUD', osis3Alt: null,   tskSource: 'Jude',               compactVariants: ['jude'],            shortCode: 'jde' },
    { id: 66, canonical: 'Revelation',      osis3: 'REV', osis3Alt: null,   tskSource: 'Revelation of John', compactVariants: ['revelation'],      shortCode: 'rev' },
];

// Derived lookup: bookId -> entry. Used by every projection function.
const byId = new Map(BOOKS.map(b => [b.id, b]));

// Derived lookup: OSIS3 code (primary or alt) -> bookId.
const byOSIS3 = new Map();
for (const b of BOOKS) {
    byOSIS3.set(b.osis3, b.id);
    if (b.osis3Alt) byOSIS3.set(b.osis3Alt, b.id);
}

// Map: bookId -> canonical name. Kept as an exported Map for the many callers
// that iterate via .get() and for ergonomic parity with older code.
export const numbersToBook = new Map(BOOKS.map(b => [b.id, b.canonical]));

// Map: 3-letter AI-prompt shortCode -> bookId. /find uses this to resolve the
// OpenAI response directly without going through the fuzzy fromInput path.
export const bookAbbreviations = new Map(BOOKS.map(b => [b.shortCode, b.id]));

// ── Projection functions ───────────────────────────────────────────────────

export function toCanonical(bookId) {
    return byId.get(bookId)?.canonical ?? null;
}

export function toTSKSource(canonicalName) {
    const entry = BOOKS.find(b => b.canonical === canonicalName);
    return entry ? entry.tskSource : canonicalName;
}

export function toOSIS3Codes(bookId) {
    const entry = byId.get(bookId);
    if (!entry) return [];
    return entry.osis3Alt ? [entry.osis3, entry.osis3Alt] : [entry.osis3];
}

export function fromOSIS3Code(code) {
    return byOSIS3.get(code) ?? null;
}

export function toCommentaryVariants(canonicalName) {
    if (!canonicalName) return [];
    const entry = BOOKS.find(b => b.canonical === canonicalName);
    if (entry) return [...entry.compactVariants];
    // Fallback preserves prior behavior for unexpected inputs (e.g., books
    // from a future extended-canon dataset that aren't in BOOKS yet).
    return [canonicalName.toLowerCase().replace(/\s+/g, '')];
}

// ── Fuzzy input resolution ─────────────────────────────────────────────────

// Inline permutation-heavy aliases. Too many variants per book (1sa / 1 sa /
// 1sam / 1 sam / 1samuel / 1 samuel / i samuel, etc.) to cleanly express as
// one column on BOOKS; kept as a flat lookup seeded from user-observed inputs.
const LEGACY_ALIASES = {
    'gen': 1, 'genesis': 1,
    'exo': 2, 'ex': 2, 'exodus': 2,
    'lev': 3, 'leviticus': 3,
    'num': 4, 'numbers': 4,
    'deu': 5, 'deut': 5, 'deuteronomy': 5,
    'jos': 6, 'josh': 6, 'joshua': 6,
    'jdg': 7, 'judg': 7, 'judges': 7,
    'rut': 8, 'ru': 8, 'rth': 8, 'ruth': 8,
    '1sa': 9, '1 sa': 9, '1sam': 9, '1 sam': 9, '1samuel': 9, '1 samuel': 9, 'i samuel': 9, 'i sam': 9,
    '2sa': 10, '2 sa': 10, '2sam': 10, '2 sam': 10, '2samuel': 10, '2 samuel': 10, 'ii samuel': 10, 'ii sam': 10,
    '1ki': 11, '1 ki': 11, '1kgs': 11, '1 kgs': 11, '1kings': 11, '1 kings': 11, 'i kings': 11,
    '2ki': 12, '2 ki': 12, '2kgs': 12, '2 kgs': 12, '2kings': 12, '2 kings': 12, 'ii kings': 12,
    '1ch': 13, '1 ch': 13, '1chr': 13, '1 chr': 13, '1chron': 13, '1 chron': 13, '1chronicles': 13, '1 chronicles': 13,
    '2ch': 14, '2 ch': 14, '2chr': 14, '2 chr': 14, '2chron': 14, '2 chron': 14, '2chronicles': 14, '2 chronicles': 14,
    'ezr': 15, 'ezra': 15,
    'neh': 16, 'nehemiah': 16,
    'est': 17, 'esth': 17, 'esther': 17,
    'job': 18,
    'psa': 19, 'ps': 19, 'psalm': 19, 'psalms': 19,
    'pro': 20, 'prov': 20, 'proverbs': 20,
    'ecc': 21, 'eccl': 21, 'ecclesiastes': 21,
    'sng': 22, 'song': 22, 'sos': 22, 'songofsolomon': 22, 'song of solomon': 22, 'songofsongs': 22, 'song of songs': 22,
    'isa': 23, 'isaiah': 23,
    'jer': 24, 'jeremiah': 24,
    'lam': 25, 'lamentations': 25,
    'eze': 26, 'ezek': 26, 'ezekiel': 26,
    'dan': 27, 'daniel': 27,
    'hos': 28, 'hosea': 28,
    'joe': 29, 'joel': 29,
    'amo': 30, 'amos': 30,
    'oba': 31, 'obad': 31, 'obadiah': 31,
    'jon': 32, 'jnh': 32, 'jonah': 32,
    'mic': 33, 'micah': 33,
    'nah': 34, 'nahum': 34,
    'hab': 35, 'habakkuk': 35,
    'zep': 36, 'zeph': 36, 'zephaniah': 36,
    'hag': 37, 'haggai': 37,
    'zec': 38, 'zech': 38, 'zechariah': 38,
    'mal': 39, 'malachi': 39,
    'mat': 40, 'matt': 40, 'mt': 40, 'matthew': 40,
    'mrk': 41, 'mk': 41, 'mar': 41, 'mark': 41,
    'luk': 42, 'lk': 42, 'luke': 42,
    'jhn': 43, 'joh': 43, 'john': 43,
    'act': 44, 'acts': 44,
    'rom': 45, 'roman': 45, 'romans': 45,
    '1co': 46, '1 co': 46, '1cor': 46, '1 cor': 46, '1corinthians': 46, '1 corinthians': 46,
    '2co': 47, '2 co': 47, '2cor': 47, '2 cor': 47, '2corinthians': 47, '2 corinthians': 47,
    'gal': 48, 'galatians': 48,
    'eph': 49, 'ephesians': 49,
    'php': 50, 'phil': 50, 'phi': 50, 'philippians': 50,
    'col': 51, 'colossians': 51,
    '1th': 52, '1 th': 52, '1thes': 52, '1 thes': 52, '1thess': 52, '1 thess': 52, '1thessalonians': 52, '1 thessalonians': 52,
    '2th': 53, '2 th': 53, '2thes': 53, '2 thes': 53, '2thess': 53, '2 thess': 53, '2thessalonians': 53, '2 thessalonians': 53,
    '1ti': 54, '1 ti': 54, '1tim': 54, '1 tim': 54, '1timothy': 54, '1 timothy': 54,
    '2ti': 55, '2 ti': 55, '2tim': 55, '2 tim': 55, '2timothy': 55, '2 timothy': 55,
    'tit': 56, 'titus': 56,
    'phm': 57, 'phlm': 57, 'philemon': 57,
    'heb': 58, 'hebrews': 58,
    'jas': 59, 'jam': 59, 'james': 59,
    '1pe': 60, '1 pe': 60, '1pet': 60, '1 pet': 60, '1peter': 60, '1 peter': 60, '1st peter': 60, 'first peter': 60, 'i peter': 60, 'i pet': 60,
    '2pe': 61, '2 pe': 61, '2pet': 61, '2 pet': 61, '2peter': 61, '2 peter': 61, '2nd peter': 61, 'second peter': 61, 'ii peter': 61, 'ii pet': 61,
    '1jo': 62, '1 jo': 62, '1jn': 62, '1 jn': 62, '1john': 62, '1 john': 62,
    '2jo': 63, '2 jo': 63, '2jn': 63, '2 jn': 63, '2john': 63, '2 john': 63,
    '3jo': 64, '3 jo': 64, '3jn': 64, '3 jn': 64, '3john': 64, '3 john': 64,
    'jud': 65, 'jude': 65, 'jde': 65,
    'rev': 66, 'rv': 66, 'revelation': 66,
};

// Common book-name misspellings seen in prod logs. These are safe to resolve
// on every path (including silent passive detection) because they aren't
// ordinary English words — a false positive is near-impossible.
const FUZZY_TYPOS = {
    'revelations': 66,
    'revalation': 66,
    'revelaton': 66,
    'revelatons': 66,
    'revalations': 66,
    // Matthew (mathew/mattew/mathhew all observed in logs)
    'mathew': 40,
    'mattew': 40,
    'mathhew': 40,
    'matthews': 40,
    // Philippians (phillipians/phillipans observed)
    'phillipians': 50,
    'phillipans': 50,
    'philipians': 50,
    'philippans': 50,
};

// Non-English book names observed in prod logs. Safe on every path — none are
// English words. This is a stopgap, not full i18n: only the names users have
// actually typed are listed. A complete localized book table is a future
// feature (see FOLLOWUPS.md). "Salmos 91" from a Spanish speaker resolving to
// Psalm 91 in passive detection is a desirable side effect.
const FOREIGN_ALIASES = {
    'salmos': 19,   // Psalms (Spanish)
    'tite': 56,     // Titus (French)
};

// Lenient aliases consulted ONLY for direct user input (the slash-command
// `book:` arg), never the silent passive-detection path. These are either
// common English words ("is" → Isaiah) or ambiguous bare names that default to
// the first book of a numbered set ("corinthians" → 1 Corinthians). Accepting
// them on every message would make the scripture-ref scanner match phrases like
// "the answer is 5" as "Isaiah 5", so they're gated behind `!silent`.
const LENIENT_ALIASES = {
    'is': 23,                                   // Isaiah — "is" is a common word
    'sam': 9, 'samuel': 9,                      // ambiguous → 1 Samuel
    'corinthians': 46,                          // ambiguous → 1 Corinthians
    'thessalonians': 52,                        // ambiguous → 1 Thessalonians
    'thes': 52, 'thess': 52,                    // ambiguous → 1 Thessalonians
    'peter': 60,                                // ambiguous → 1 Peter
    'timothy': 54,                              // ambiguous → 1 Timothy
};

// Resolve a user-provided book name/abbreviation to a bookId (1–66).
// Called on every book-referencing command — sometimes 200+ times per
// invocation (e.g., /topicalindex resolving a topic's references). Keep quiet
// in prod; only the final "not found" path logs, at warn level.
//
// Pass `{ silent: true }` for probe-style callers (e.g., the scripture-ref
// parser) that try every word in a message and only expect a small fraction
// to resolve — the warn noise would drown real signal otherwise.
export function getBookId(bookName, { silent = false } = {}) {
    if (!bookName) return null;

    let lowercaseInput = bookName.toLowerCase().trim();

    // Normalize Roman-numeral book prefixes ("i john", "ii samuel", "iii jn")
    // to their Arabic equivalents ("1 john", "2 samuel", "3 jn"). One entry
    // point beats sprinkling Roman aliases across LEGACY_ALIASES — that
    // coverage was inconsistent (present for Samuel/Kings, missing for
    // John/Corinthians). Regex requires whitespace after to avoid eating the
    // "i" in "isaiah" / "ichabod".
    lowercaseInput = lowercaseInput.replace(/^(i{1,3})\s+/, (_, romans) => `${romans.length} `);

    const noSpaceInput = lowercaseInput.replace(/\s+/g, '');
    const normalizedInput = lowercaseInput.replace(/\s+/g, ' ');

    const viaLegacy = LEGACY_ALIASES[lowercaseInput]
        ?? LEGACY_ALIASES[noSpaceInput]
        ?? LEGACY_ALIASES[normalizedInput];
    if (viaLegacy) return viaLegacy;

    const viaForeign = FOREIGN_ALIASES[lowercaseInput] ?? FOREIGN_ALIASES[noSpaceInput];
    if (viaForeign) return viaForeign;

    const viaTypo = FUZZY_TYPOS[lowercaseInput] ?? FUZZY_TYPOS[noSpaceInput];
    if (viaTypo) return viaTypo;

    for (const b of BOOKS) {
        const n = b.canonical.toLowerCase();
        if (n === lowercaseInput || n === noSpaceInput || n === normalizedInput) {
            return b.id;
        }
    }

    // Direct user input only: common English-word and ambiguous bare names that
    // would cause false positives if the passive message scanner accepted them.
    if (!silent) {
        const viaLenient = LENIENT_ALIASES[lowercaseInput] ?? LENIENT_ALIASES[noSpaceInput];
        if (viaLenient) return viaLenient;
    }

    // Book name with the chapter number stuck on the end, no separator
    // ("salmos91", "proverbs6"). Strip a trailing run of digits and resolve the
    // alphabetic prefix. Silent recursion so a failed split stays quiet; the
    // outer call owns the single "not found" warning.
    const digitSplit = lowercaseInput.match(/^([a-z][a-z\s]*?)\s*\d+$/);
    if (digitSplit) {
        const prefixId = getBookId(digitSplit[1], { silent: true });
        if (prefixId) return prefixId;
    }

    if (!silent) {
        logger.warn(`[Book Lookup] No match found for book: "${lowercaseInput}"`);
    }
    return null;
}
