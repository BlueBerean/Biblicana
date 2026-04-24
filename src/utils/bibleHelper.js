import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const booksJson = require('../../data/books.json');
const __dirname = dirname(fileURLToPath(import.meta.url));

// Map: Abbreviation -> Book ID (Used by /find)
export const bookAbbreviations = new Map([
    ['gen', 1], ['exo', 2], ['lev', 3], ['num', 4], ['deu', 5],
    ['jos', 6], ['jdg', 7], ['rut', 8], ['1sa', 9], ['2sa', 10],
    ['1ki', 11], ['2ki', 12], ['1ch', 13], ['2ch', 14], ['ezr', 15],
    ['neh', 16], ['est', 17], ['job', 18], ['psa', 19], ['pro', 20],
    ['ecc', 21], ['sos', 22], ['isa', 23], ['jer', 24], ['lam', 25],
    ['eze', 26], ['dan', 27], ['hos', 28], ['joe', 29], ['amo', 30],
    ['oba', 31], ['jon', 32], ['mic', 33], ['nah', 34], ['hab', 35],
    ['zep', 36], ['hag', 37], ['zec', 38], ['mal', 39], ['mat', 40],
    ['mar', 41], ['luk', 42], ['joh', 43], ['act', 44], ['rom', 45],
    ['1co', 46], ['2co', 47], ['gal', 48], ['eph', 49], ['php', 50],
    ['col', 51], ['1th', 52], ['2th', 53], ['1ti', 54], ['2ti', 55],
    ['tit', 56], ['phm', 57], ['heb', 58], ['jam', 59], ['1pe', 60],
    ['2pe', 61], ['1jo', 62], ['2jo', 63], ['3jo', 64], ['jde', 65],
    ['rev', 66]
]);

const numSuperMap = new Map([
    [0, '⁰'], [1, '¹'], [2, '²'], [3, '³'], [4, '⁴'],
    [5, '⁵'], [6, '⁶'], [7, '⁷'], [8, '⁸'], [9, '⁹']
]);

/**
 * @param {number} number Number to convert to superscript
 * @returns {string} The superscripted number
 * @example numberToSuperScript(123) // returns ¹²³
 */
export const numberToSuperScript = (number) => {
    let superScript = '';
    for (const digit of number.toString()) {
        superScript += numSuperMap.get(parseInt(digit));
    }
    return superScript;
};

const biblePromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'bible.db');
    return open({
        filename: filePath,
        driver: sqlite3.Database,
        readOnly: true
    });
})();

const strongsPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'strongs.db');
    return open({
        filename: filePath,
        driver: sqlite3.Database,
        readOnly: true
    });
})();

class BibleWrapper {
    constructor() {
        this.db = biblePromise;
    }

    /** @deprecated Use getVerses. */
    async getVerse(book, chapter, verse) {
        const db = await this.db;
        return db.get(
            `SELECT * FROM english WHERE book = ? AND chapter = ? AND verse = ?`,
            [book, chapter, verse]
        );
    }

    async getVerses(book, chapter, startVerse, endVerse) {
        const db = await this.db;
        return db.all(
            `SELECT * FROM english WHERE bookID = ? AND chapter = ? AND verse BETWEEN ? AND ?`,
            [book, chapter, startVerse, endVerse]
        );
    }

    async getInterlinearVerse(book, chapter, verse) {
        const db = await this.db;
        return db.get(
            `SELECT * FROM interlinear WHERE bookid = ? AND chapter = ? AND verse = ?`,
            [book, chapter, verse]
        );
    }

    /**
     * Returns a single random verse row, optionally scoped to a book or a
     * specific chapter within a book. Returns undefined if no row matches.
     */
    async getRandomVerse(filterBookId = null, filterChapter = null) {
        const db = await this.db;
        const conditions = [];
        const params = [];
        if (filterBookId) {
            conditions.push('bookID = ?');
            params.push(filterBookId);
        }
        if (filterChapter) {
            conditions.push('chapter = ?');
            params.push(filterChapter);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return db.get(
            `SELECT * FROM english ${whereClause} ORDER BY RANDOM() LIMIT 1`,
            params
        );
    }
}

class StrongsWrapper {
    constructor() {
        this.db = strongsPromise;
    }

    /** @deprecated */
    async getStrongsUnicode(language, unicode) {
        const db = await this.db;
        return db.get(`SELECT * FROM ${language} WHERE unicode = ?`, [unicode]);
    }

    async getStrongsEnglish(language, english) {
        const db = await this.db;
        const query = await db.all(
            `SELECT * FROM ${language} WHERE kjvdef LIKE ?`,
            [`%${english}%`]
        );
        if (query.length == 0) return null;
        return query;
    }

    // Tries the full Strong's ID (e.g., "G2316") first, then falls back to
    // just the numeric part ("2316") since some rows are keyed without the
    // language prefix. "No match" is normal (many words have no Strong's)
    // so it logs at debug — only real DB errors bubble up at error level.
    async getStrongsId(language, id) {
        if (!id) return undefined;

        const db = await this.db;
        const normalizedLanguage = language.toLowerCase();
        const tableName = normalizedLanguage === 'greek' ? 'Greek' : 'Hebrew';

        try {
            let result = await db.get(`SELECT * FROM ${tableName} WHERE strongs = ?`, [id]);
            if (result) return result;

            const numberPart = id.substring(1);
            if (numberPart && !isNaN(numberPart)) {
                result = await db.get(`SELECT * FROM ${tableName} WHERE strongs = ?`, [numberPart]);
                if (result) return result;
            }
            return undefined;
        } catch (error) {
            logger.error(`[Strongs Wrapper] Database error querying ${tableName} for ${id}: ${error.message}`);
            return undefined;
        }
    }
}

/** A map representing a list of book abbreviations (from books.json) */
export const books = new Map(Object.entries(booksJson));

/** A map representing a list of book numbers to names */
export const numbersToBook = new Map([
    [1, 'Genesis'], [2, 'Exodus'], [3, 'Leviticus'], [4, 'Numbers'],
    [5, 'Deuteronomy'], [6, 'Joshua'], [7, 'Judges'], [8, 'Ruth'],
    [9, '1 Samuel'], [10, '2 Samuel'], [11, '1 Kings'], [12, '2 Kings'],
    [13, '1 Chronicles'], [14, '2 Chronicles'], [15, 'Ezra'], [16, 'Nehemiah'],
    [17, 'Esther'], [18, 'Job'], [19, 'Psalms'], [20, 'Proverbs'],
    [21, 'Ecclesiastes'], [22, 'Song of Solomon'], [23, 'Isaiah'], [24, 'Jeremiah'],
    [25, 'Lamentations'], [26, 'Ezekiel'], [27, 'Daniel'], [28, 'Hosea'],
    [29, 'Joel'], [30, 'Amos'], [31, 'Obadiah'], [32, 'Jonah'],
    [33, 'Micah'], [34, 'Nahum'], [35, 'Habakkuk'], [36, 'Zephaniah'],
    [37, 'Haggai'], [38, 'Zechariah'], [39, 'Malachi'], [40, 'Matthew'],
    [41, 'Mark'], [42, 'Luke'], [43, 'John'], [44, 'Acts'],
    [45, 'Romans'], [46, '1 Corinthians'], [47, '2 Corinthians'], [48, 'Galatians'],
    [49, 'Ephesians'], [50, 'Philippians'], [51, 'Colossians'], [52, '1 Thessalonians'],
    [53, '2 Thessalonians'], [54, '1 Timothy'], [55, '2 Timothy'], [56, 'Titus'],
    [57, 'Philemon'], [58, 'Hebrews'], [59, 'James'], [60, '1 Peter'],
    [61, '2 Peter'], [62, '1 John'], [63, '2 John'], [64, '3 John'],
    [65, 'Jude'], [66, 'Revelation']
]);

/** Singleton wrapper instances (DB connections) */
export const strongsWrapper = new StrongsWrapper();
export const bibleWrapper = new BibleWrapper();

// Translation IDs we no longer surface to users because we don't currently
// hold commercial redistribution rights. Reads that still receive one of
// these values (e.g., from a stored user preference set before the removal)
// fall back to BSB via coerceTranslation. The columns remain in bible.db so
// data stays intact if we later secure a license; surfacing is gated at the
// code layer.
const DEPRECATED_TRANSLATIONS = new Set(['NASB', 'NKJV', 'AMPC']);

/**
 * Map any translation identifier to a surfacing-safe value. Null/undefined
 * or empty input → 'BSB'. A translation in DEPRECATED_TRANSLATIONS → 'BSB'.
 * Anything else → passed through unchanged.
 *
 * Used by every command that resolves a translation from slash-command
 * options OR from the user's stored preference. Centralizing here means a
 * single change (removing from the deprecated set, or adding a new one)
 * propagates to every translation-aware command without touching them.
 */
export function coerceTranslation(translation) {
    if (!translation) return 'BSB';
    return DEPRECATED_TRANSLATIONS.has(translation) ? 'BSB' : translation;
}

// Case-insensitive book name lookup with fuzzy matching.
// Called on every book-referencing command, sometimes 200+ times per invocation
// (e.g., /topicalindex resolving a topic's references). Must stay quiet in prod;
// only the final "not found" path logs, at warn level.
export function getBookId(bookName) {
    if (!bookName) return null;

    const lowercaseInput = bookName.toLowerCase().trim();
    const noSpaceInput = lowercaseInput.replace(/\s+/g, '');
    const normalizedInput = lowercaseInput.replace(/\s+/g, ' ');

    const commonAbbreviations = {
        'gen': 1, 'genesis': 1,
        'exo': 2, 'exodus': 2,
        'lev': 3, 'leviticus': 3,
        'num': 4, 'numbers': 4,
        'deu': 5, 'deuteronomy': 5,
        'jos': 6, 'joshua': 6,
        'jdg': 7, 'judges': 7,
        'rut': 8, 'ruth': 8,
        '1sa': 9, '1 sa': 9, '1sam': 9, '1 sam': 9, '1samuel': 9, '1 samuel': 9,
        '2sa': 10, '2 sa': 10, '2sam': 10, '2 sam': 10, '2samuel': 10, '2 samuel': 10,
        '1ki': 11, '1 ki': 11, '1kgs': 11, '1 kgs': 11, '1kings': 11, '1 kings': 11,
        '2ki': 12, '2 ki': 12, '2kgs': 12, '2 kgs': 12, '2kings': 12, '2 kings': 12,
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
        'mat': 40, 'matt': 40, 'matthew': 40,
        'mrk': 41, 'mk': 41, 'mar': 41, 'mark': 41,
        'luk': 42, 'lk': 42, 'luke': 42,
        'jhn': 43, 'joh': 43, 'john': 43,
        'act': 44, 'acts': 44,
        'rom': 45, 'romans': 45,
        '1co': 46, '1 co': 46, '1cor': 46, '1 cor': 46, '1corinthians': 46, '1 corinthians': 46,
        '2co': 47, '2 co': 47, '2cor': 47, '2 cor': 47, '2corinthians': 47, '2 corinthians': 47,
        'gal': 48, 'galatians': 48,
        'eph': 49, 'ephesians': 49,
        'php': 50, 'phil': 50, 'philippians': 50,
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
        'jud': 65, 'jude': 65,
        'rev': 66, 'rv': 66, 'revelation': 66
    };

    const commonId = commonAbbreviations[lowercaseInput] ||
                     commonAbbreviations[noSpaceInput] ||
                     commonAbbreviations[normalizedInput];
    if (commonId) return commonId;

    for (const [key, value] of books) {
        const k = key.toLowerCase();
        if (k === lowercaseInput || k === noSpaceInput || k === normalizedInput) {
            return parseInt(value);
        }
    }

    const fuzzyMatches = {
        'revelations': 66,
        'revalation': 66,
        'revelaton': 66,
        'revelatons': 66,
        'revalations': 66
    };
    if (fuzzyMatches[lowercaseInput]) return fuzzyMatches[lowercaseInput];

    for (const [id, name] of numbersToBook.entries()) {
        const n = name.toLowerCase();
        if (n === lowercaseInput || n === noSpaceInput || n === normalizedInput) {
            return id;
        }
    }

    logger.warn(`[Book Lookup] No match found for book: "${lowercaseInput}"`);
    return null;
}
