import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fathersPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'extrabiblical_data.sqlite');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

const personPlacesPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'person_places.db');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

const dictionaryPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'dictionary.sqlite');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

const crossRefPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'cross-references.sqlite');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

const categoriesPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'categories.sqlite');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

const commentaryPromise = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'clean_commentary.db');
    return open({ filename: filePath, driver: sqlite3.Database, readOnly: true });
})();

// TSK cross_references.source_book uses Roman numerals ("I Samuel", "II Kings")
// and "Revelation of John" instead of the Arabic numerals numbersToBook provides.
// Target column uses Arabic, so only source-side lookups need conversion.
const TSK_SOURCE_BOOK_OVERRIDES = {
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

export function toTSKSourceBook(canonicalName) {
    return TSK_SOURCE_BOOK_OVERRIDES[canonicalName] || canonicalName;
}

// Map numbersToBook id -> 3-letter uppercase bookId used by clean_commentary.db.
// (OSIS-like convention.)
const BOOKID_TO_OSIS3 = {
    1: 'GEN', 2: 'EXO', 3: 'LEV', 4: 'NUM', 5: 'DEU',
    6: 'JOS', 7: 'JDG', 8: 'RUT', 9: '1SA', 10: '2SA',
    11: '1KI', 12: '2KI', 13: '1CH', 14: '2CH', 15: 'EZR',
    16: 'NEH', 17: 'EST', 18: 'JOB', 19: 'PSA', 20: 'PRO',
    21: 'ECC', 22: 'SNG', 23: 'ISA', 24: 'JER', 25: 'LAM',
    26: 'EZK', 27: 'DAN', 28: 'HOS', 29: 'JOL', 30: 'AMO',
    31: 'OBA', 32: 'JON', 33: 'MIC', 34: 'NAM', 35: 'HAB',
    36: 'ZEP', 37: 'HAG', 38: 'ZEC', 39: 'MAL', 40: 'MAT',
    41: 'MRK', 42: 'LUK', 43: 'JHN', 44: 'ACT', 45: 'ROM',
    46: '1CO', 47: '2CO', 48: 'GAL', 49: 'EPH', 50: 'PHP',
    51: 'COL', 52: '1TH', 53: '2TH', 54: '1TI', 55: '2TI',
    56: 'TIT', 57: 'PHM', 58: 'HEB', 59: 'JAS', 60: '1PE',
    61: '2PE', 62: '1JN', 63: '2JN', 64: '3JN', 65: 'JUD',
    66: 'REV',
};

// Four books also have mixed-case codes used by one commentator
// (same book, different code — query both to match either)
const BOOKID_ALT_CODES = {
    26: 'Ezek',
    34: 'Nah',
    50: 'Phil',
    57: 'Phlm',
};

export function toCommentaryBookCodes(bookId) {
    const primary = BOOKID_TO_OSIS3[bookId];
    if (!primary) return [];
    const alt = BOOKID_ALT_CODES[bookId];
    return alt ? [primary, alt] : [primary];
}

// Reverse map: commentary book code (primary OSIS3 uppercase or mixed-case alt) -> bookId
const OSIS3_TO_BOOKID = Object.fromEntries([
    ...Object.entries(BOOKID_TO_OSIS3).map(([id, code]) => [code, parseInt(id)]),
    ...Object.entries(BOOKID_ALT_CODES).map(([id, code]) => [code, parseInt(id)]),
]);

export function fromCommentaryBookCode(code) {
    return OSIS3_TO_BOOKID[code] ?? null;
}

export const COMMENTATORS = [
    { id: 'john-gill',              label: "John Gill" },
    { id: 'matthew-henry',          label: "Matthew Henry" },
    { id: 'adam-clarke',            label: "Adam Clarke" },
    { id: 'jamieson-fausset-brown', label: "Jamieson-Fausset-Brown" },
    { id: 'keil-delitzsch',         label: "Keil & Delitzsch (OT only)" },
    { id: 'tyndale',                label: "Tyndale Open Study Notes" },
];

class FathersWrapper {
    constructor() { this.db = fathersPromise; }

    async getByPassage(books, chapter, verse, fatherFilter = null) {
        const db = await this.db;
        const bookList = Array.isArray(books) ? books : [books];
        const loc = chapter * 1_000_000 + verse;
        const placeholders = bookList.map(() => '?').join(',');
        const params = [...bookList, loc, loc];
        // LEFT JOIN father_meta pulls wiki_url + default_year inline so /fathers
        // can show a Wikipedia button without a second round-trip per Father.
        let sql = `SELECT c.father_name, c.txt, c.source_url, c.source_title,
                          c.location_start, c.location_end,
                          m.wiki_url, m.default_year
                   FROM commentary c
                   LEFT JOIN father_meta m ON m.name = c.father_name COLLATE NOCASE
                   WHERE c.book IN (${placeholders}) AND c.location_start <= ? AND c.location_end >= ?`;
        if (fatherFilter) {
            // Escape LIKE wildcards so a user filter of '%' or '_' doesn't bypass
            // the filter by matching everything. Pair with ESCAPE '\\'.
            const escaped = fatherFilter.replace(/[\\%_]/g, ch => `\\${ch}`);
            sql += ` AND c.father_name LIKE ? ESCAPE '\\'`;
            params.push(`%${escaped}%`);
        }
        sql += ` ORDER BY c.father_name LIMIT 50`;
        return db.all(sql, params);
    }

    async fatherMeta(name) {
        const db = await this.db;
        return db.get(
            `SELECT name, default_year, wiki_url FROM father_meta WHERE name = ? COLLATE NOCASE`,
            [name]
        );
    }
}

class PersonsWrapper {
    constructor() { this.db = personPlacesPromise; }

    async search(name) {
        const db = await this.db;
        const underscored = name.replace(/\s+/g, '_');
        return db.all(
            `SELECT id, unique_name, uStrong, father, mother, siblings, partners, offspring, tribe, sex, short_description, ext_description
             FROM persons
             WHERE unique_name LIKE ? COLLATE NOCASE
             ORDER BY unique_name
             LIMIT 25`,
            [`${underscored}_%`]
        );
    }
}

class PlacesWrapper {
    constructor() { this.db = personPlacesPromise; }

    async search(name) {
        const db = await this.db;
        const underscored = name.replace(/\s+/g, '_');
        return db.all(
            `SELECT id, unique_name, uStrong, openbible_name, lonlat, short_description, ext_description, pleiades, wikidata
             FROM places
             WHERE unique_name LIKE ? COLLATE NOCASE OR openbible_name LIKE ? COLLATE NOCASE
             ORDER BY unique_name
             LIMIT 25`,
            [`${underscored}_%`, `%${name}%`]
        );
    }
}

class DictionaryWrapper {
    constructor() { this.db = dictionaryPromise; }

    async search(term) {
        const db = await this.db;

        const exactResults = await db.all(
            `SELECT e.id, e.term, e.definition, s.name AS source_name
             FROM dictionary_entries e
             JOIN dictionary_sources s ON s.id = e.source_id
             WHERE e.term = ? COLLATE NOCASE
             ORDER BY s.id`,
            [term]
        );

        if (exactResults.length > 0) {
            return { results: exactResults, matchType: 'exact' };
        }

        const fallbackResults = await db.all(
            `SELECT e.id, e.term, e.definition, s.name AS source_name
             FROM dictionary_entries e
             JOIN dictionary_sources s ON s.id = e.source_id
             WHERE e.definition LIKE ? COLLATE NOCASE
             ORDER BY LENGTH(e.definition) ASC, s.id
             LIMIT 25`,
            [`%${term}%`]
        );

        return { results: fallbackResults, matchType: 'definition' };
    }
}

class CrossRefWrapper {
    constructor() { this.db = crossRefPromise; }

    async getForVerse(canonicalBookName, chapter, verse) {
        const db = await this.db;
        const sourceBook = toTSKSourceBook(canonicalBookName);
        return db.all(
            `SELECT target_book, target_chapter, target_verse_start, target_verse_end
             FROM cross_references
             WHERE source_book = ? AND source_chapter = ? AND source_verse = ?
             ORDER BY id`,
            [sourceBook, chapter, verse]
        );
    }
}

class CategoriesWrapper {
    constructor() { this.db = categoriesPromise; }

    async getRefsForTopic(topicName) {
        const db = await this.db;
        return db.all(
            `SELECT cr.book, cr.chapter, cr.verse, cr.start_verse, cr.end_verse
             FROM category_references cr
             JOIN categories c ON c.id = cr.category_id
             WHERE LOWER(c.name) = LOWER(?)
             ORDER BY cr.id`,
            [topicName]
        );
    }

    async totalCategoryCount() {
        const db = await this.db;
        const row = await db.get(`SELECT COUNT(*) AS cnt FROM categories`);
        return row?.cnt ?? 0;
    }
}

class CommentaryWrapper {
    constructor() { this.db = commentaryPromise; }

    async searchProfiles(subject) {
        const db = await this.db;

        const exactResults = await db.all(
            `SELECT p.id, p.subject, p.content, p.commentaryId,
                    p.referenceBook, p.referenceChapter, p.referenceVerse,
                    p.referenceEndChapter, p.referenceEndVerse,
                    c.name AS commentaryName
             FROM CommentaryProfile p
             JOIN Commentary c ON c.id = p.commentaryId
             WHERE LOWER(p.subject) = LOWER(?)
             ORDER BY p.subject`,
            [subject]
        );

        if (exactResults.length > 0) {
            return { results: exactResults, matchType: 'exact' };
        }

        const fuzzyResults = await db.all(
            `SELECT p.id, p.subject, p.content, p.commentaryId,
                    p.referenceBook, p.referenceChapter, p.referenceVerse,
                    p.referenceEndChapter, p.referenceEndVerse,
                    c.name AS commentaryName
             FROM CommentaryProfile p
             JOIN Commentary c ON c.id = p.commentaryId
             WHERE LOWER(p.subject) LIKE LOWER(?)
             ORDER BY LENGTH(p.subject) ASC, p.subject
             LIMIT 25`,
            [`%${subject}%`]
        );

        return { results: fuzzyResults, matchType: 'fuzzy' };
    }

    async getVerseCommentary(commentaryId, bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        return db.get(
            `SELECT text FROM CommentaryChapterVerse
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND chapterNumber = ? AND number = ?
             LIMIT 1`,
            [commentaryId, ...codes, chapter, verse]
        );
    }

    async getChapterCommentary(commentaryId, bookCodes, chapter) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        return db.get(
            `SELECT introduction FROM CommentaryChapter
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND number = ?
             LIMIT 1`,
            [commentaryId, ...codes, chapter]
        );
    }
}

export function toCommentaryBookVariants(canonicalName) {
    if (!canonicalName) return [];
    const compact = canonicalName.toLowerCase().replace(/\s+/g, '');
    if (compact === 'psalms') return ['psalms', 'psalm'];
    return [compact];
}

export const fathersWrapper = new FathersWrapper();
export const personsWrapper = new PersonsWrapper();
export const placesWrapper = new PlacesWrapper();
export const dictionaryWrapper = new DictionaryWrapper();
export const crossRefWrapper = new CrossRefWrapper();
export const categoriesWrapper = new CategoriesWrapper();
export const commentaryWrapper = new CommentaryWrapper();
