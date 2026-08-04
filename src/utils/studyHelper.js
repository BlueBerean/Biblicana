import { fileURLToPath } from 'node:url';
import path, { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { toTSKSource, getBookId } from './bookNames.js';

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

export const COMMENTATORS = [
    { id: 'john-gill',              label: "John Gill" },
    { id: 'matthew-henry',          label: "Matthew Henry" },
    { id: 'adam-clarke',            label: "Adam Clarke" },
    { id: 'jamieson-fausset-brown', label: "Jamieson-Fausset-Brown" },
    { id: 'keil-delitzsch',         label: "Keil & Delitzsch (OT only)" },
    { id: 'tyndale',                label: "Tyndale Open Study Notes" },
];

// Preferred order for "lead Father name" in stat lines (e.g., the reaction-
// expansion reply's "📜 {name} + N other Fathers"). Matched case-insensitively
// as a substring against `father_name`, so "Augustine" picks up "Augustine of
// Hippo". First marquee entry with a hit wins; fall through to alphabetical.
// Curated for name recognition, not theological hierarchy — the goal is users
// see a name that signals depth, not a canonical ordering of importance.
const MARQUEE_FATHERS = [
    'Augustine',
    'John Chrysostom', 'Chrysostom',
    'Thomas Aquinas', 'Aquinas',
    'Jerome',
    'Athanasius',
    'Ambrose',
    'Origen',
    'Irenaeus',
    'Gregory the Great',
    'Tertullian',
    'Basil',
    'Cyprian',
    'Clement of Alexandria',
    'Justin Martyr',
    'Polycarp',
    'Ignatius',
];

/**
 * Pick the most recognizable Father name out of a result set. Used for the
 * stat-line lead; doesn't affect which rows are returned or ordered to users
 * in the /fathers command.
 *
 * Returns the picked father_name string, or null if rows is empty.
 */
export function pickMarqueeFather(fathersRows) {
    if (!fathersRows || fathersRows.length === 0) return null;
    for (const marquee of MARQUEE_FATHERS) {
        const needle = marquee.toLowerCase();
        const match = fathersRows.find(f => f.father_name?.toLowerCase().includes(needle));
        if (match) return match.father_name;
    }
    return fathersRows[0].father_name ?? null;
}

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
            // Punctuation-insensitive match. The DB stores names without
            // periods ("CS Lewis"), so a bare LIKE '%C.S. Lewis%' matched
            // nothing — the user typed the name correctly and got no results.
            //
            // Normalising BOTH sides fixes the class rather than one author:
            // "C.S. Lewis", "CS Lewis" and "c s lewis" all collapse to
            // "cslewis". The nested replace() forces a scan, but the row set is
            // already bounded by book and location, so it stays cheap.
            //
            // Wildcards are still escaped so a filter of '%' or '_' cannot
            // bypass the filter by matching everything.
            const normalized = normalizeFatherName(fatherFilter).replace(/[\\%_]/g, ch => `\\${ch}`);
            sql += ` AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(c.father_name), '.', ''), ' ', ''), '-', ''), '''', '') LIKE ? ESCAPE '\\'`;
            params.push(`%${normalized}%`);
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

    // Distinct list of all fathers with their entry counts + metadata for a
    // "who can I search?" directory page. NULL default_year values (fathers
    // without dating metadata) are sorted last.
    async listAllFathers() {
        const db = await this.db;
        return db.all(
            `SELECT c.father_name AS name,
                    m.default_year AS year,
                    m.wiki_url    AS wiki_url,
                    COUNT(c.id)   AS entry_count
             FROM commentary c
             LEFT JOIN father_meta m ON m.name = c.father_name COLLATE NOCASE
             GROUP BY c.father_name
             ORDER BY
                CASE WHEN m.default_year IS NULL THEN 1 ELSE 0 END,
                m.default_year ASC,
                c.father_name ASC`
        );
    }
}

/**
 * Split a person/place `unique_name` into its display parts.
 *
 * Format is "Name_Book.Chapter.Verse" — "Mary_Magdalene_Mat.27.56",
 * "Akeldama_Mat.27.7" — i.e. the name may itself contain underscores, so only
 * the LAST segment is the reference.
 *
 * Lives here rather than in a command file because persons.js, places.js and
 * the AI chat tools all need identical formatting; it was previously duplicated
 * verbatim (modulo variable names) in the two command files.
 *
 * @returns {{name: string, firstRef: string, structured: ?{bookId: number, chapter: number, verse: number}}}
 */
export function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '', structured: null };
    const parts = String(uniqueName).split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');

    let structured = null;
    const refParts = ref.split('.');
    if (refParts.length === 3) {
        const [bookCode, chapterStr, verseStr] = refParts;
        const bookId = getBookId(bookCode.toLowerCase(), { silent: true });
        const chapter = parseInt(chapterStr, 10);
        const verse = parseInt(verseStr, 10);
        if (bookId && !isNaN(chapter) && !isNaN(verse)) {
            structured = { bookId, chapter, verse };
        }
    }

    return { name, firstRef: ref.replace(/\./g, ' '), structured };
}

/**
 * Collapse a Father's name to a punctuation-free, lowercase key.
 *
 * Must stay in sync with the SQL expression in getByPassage — both sides of the
 * comparison have to be normalised identically or the match silently fails.
 */
export function normalizeFatherName(name) {
    return String(name ?? '').toLowerCase().replace(/[.\s'-]/g, '');
}

/**
 * Classify a "Church Father" by year.
 *
 * The extrabiblical_data collection is really 2,000 years of Christian
 * commentary under a patristic label: 275 patristic, 36 medieval (Aquinas,
 * Bernard), 13 modern (C.S. Lewis, Tolkien, and at least one living author).
 * Presenting any of the latter as "the early church" would be a factual error,
 * so every surface that shows these rows needs the same classification.
 *
 * Lives here rather than in aiChat.js because /fathers needs it too — it was
 * previously a private function declaration inside the AI tools section, which
 * is why the slash command shipped without the filter the AI path had.
 *
 * default_year is stored as TEXT, so it needs parseInt. 9999 marks
 * pseudonymous/undated works, which are patristic-adjacent. The patristic era
 * closes ~AD 800 (John of Damascus).
 */
export function classifyFather(yearRaw) {
    const y = parseInt(yearRaw, 10);
    if (!Number.isFinite(y) || y === 9999) return { patristic: true, era: 'early Church Father, date uncertain' };
    if (y <= 800) return { patristic: true, era: `early Church Father, c. AD ${y}` };
    if (y <= 1499) return { patristic: false, era: `medieval writer (c. ${y}) — NOT a Church Father` };
    if (y <= 1700) return { patristic: false, era: `Reformation-era writer (c. ${y}) — NOT a Church Father` };
    return { patristic: false, era: `modern author (c. ${y}) — NOT a Church Father` };
}

/**
 * Short, user-facing era label for the /fathers command.
 *
 * classifyFather's `era` strings are written to instruct a MODEL (they shout
 * "NOT a Church Father"), which reads as scolding in a UI. This returns
 * something suitable for a human: null when the author is genuinely patristic,
 * a compact tag otherwise.
 */
export function fatherEraBadge(yearRaw) {
    const y = parseInt(yearRaw, 10);
    if (!Number.isFinite(y) || y === 9999) return null;
    if (y <= 800) return null;
    if (y <= 1499) return `Medieval · c. ${y}`;
    if (y <= 1700) return `Reformation era · c. ${y}`;
    return `Modern · c. ${y}`;
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

    // Priority-ordered search so "Jerusalem" surfaces Jerusalem itself before
    // "Beautiful Gate (in Jerusalem)", etc.
    //   0 — openbible_name is exactly the query
    //   1 — unique_name starts with "query_"  (canonical name prefix)
    //   2 — openbible_name starts with the query
    //   3 — anything else that matches (fallback substring)
    async search(name) {
        const db = await this.db;
        const underscored = name.replace(/\s+/g, '_');
        const namePrefix = `${underscored}_%`;
        const obPrefix = `${name}%`;
        const obSubstr = `%${name}%`;
        return db.all(
            `SELECT id, unique_name, uStrong, openbible_name, lonlat, short_description, ext_description, pleiades, wikidata
             FROM places
             WHERE unique_name LIKE ? COLLATE NOCASE
                OR openbible_name LIKE ? COLLATE NOCASE
             ORDER BY
                CASE
                    WHEN openbible_name = ? COLLATE NOCASE THEN 0
                    WHEN unique_name LIKE ? COLLATE NOCASE THEN 1
                    WHEN openbible_name LIKE ? COLLATE NOCASE THEN 2
                    ELSE 3
                END,
                unique_name
             LIMIT 25`,
            [namePrefix, obSubstr, name, namePrefix, obPrefix]
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

    // `limit` is optional: the AI tool passes a small cap so a verse with many
    // TSK refs doesn't pull the whole set into memory just to use the first 15.
    // Slash callers (/crossref) omit it — they paginate through every ref.
    async getForVerse(canonicalBookName, chapter, verse, limit = null) {
        const db = await this.db;
        const sourceBook = toTSKSource(canonicalBookName);
        const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
        return db.all(
            `SELECT target_book, target_chapter, target_verse_start, target_verse_end
             FROM cross_references
             WHERE source_book = ? AND source_chapter = ? AND source_verse = ?
             ORDER BY id${cap}`,
            [sourceBook, chapter, verse]
        );
    }
}

class CategoriesWrapper {
    constructor() { this.db = categoriesPromise; }

    // `limit` is optional: the AI tool passes a cap (a major topic like "love"
    // indexes thousands of refs, but the tool only surfaces ~12). /topicalindex
    // omits it — it paginates the full set, so it needs every row.
    async getRefsForTopic(topicName, limit = null) {
        const db = await this.db;
        const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : '';
        return db.all(
            `SELECT cr.book, cr.chapter, cr.verse, cr.start_verse, cr.end_verse
             FROM category_references cr
             JOIN categories c ON c.id = cr.category_id
             WHERE LOWER(c.name) = LOWER(?)
             ORDER BY cr.id${cap}`,
            [topicName]
        );
    }

    async totalCategoryCount() {
        const db = await this.db;
        const row = await db.get(`SELECT COUNT(*) AS cnt FROM categories`);
        return row?.cnt ?? 0;
    }

    // Fuzzy topic-name search for suggestion fallbacks. getRefsForTopic requires
    // an exact (case-insensitive) name match; when an AI tool-call passes a topic
    // that doesn't match exactly, this surfaces the closest indexed names so the
    // model can retry with a real one. Shortest names first (closest to the bare
    // topic, e.g. "Pride" before "The Spirit Of Pride").
    async searchTopics(partial, limit = 12) {
        const db = await this.db;
        const rows = await db.all(
            `SELECT DISTINCT name FROM categories
             WHERE LOWER(name) LIKE LOWER(?)
             ORDER BY LENGTH(name) ASC, name
             LIMIT ?`,
            [`%${partial}%`, limit]
        );
        return rows.map(r => r.name);
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

    // Like getVerseCommentary, but when no exact verse-level entry exists, falls
    // back to the commentary block that COVERS the verse — the entry with the
    // greatest start-verse <= the target in that chapter. Necessary because some
    // commentators are passage-grouped rather than verse-by-verse: Matthew Henry's
    // entire note on Philippians 4:1-9 is keyed only at verse 1, so an exact lookup
    // for 4:6 misses entirely and silently falls back to a different commentator.
    // Returns { text, coveredFrom } — coveredFrom is the block's start verse (equals
    // the requested verse on an exact hit) so callers can label a passage note
    // accurately — or null if the commentator has nothing at/ before the verse.
    async getVerseCommentaryCovering(commentaryId, bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return null;
        const placeholders = codes.map(() => '?').join(',');
        const row = await db.get(
            `SELECT text, number FROM CommentaryChapterVerse
             WHERE commentaryId = ? AND bookId IN (${placeholders})
             AND chapterNumber = ? AND number <= ?
             ORDER BY number DESC
             LIMIT 1`,
            [commentaryId, ...codes, chapter, verse]
        );
        if (!row?.text) return null;
        return { text: row.text, coveredFrom: row.number };
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

    // How many of the six commentators have content for a given verse?
    // Powers the reaction-expansion stat line without doing one query per
    // commentator — a single COUNT(DISTINCT commentaryId) is ~O(ms) against
    // the indexed bookId/chapterNumber/number columns.
    async countCommentatorsForVerse(bookCodes, chapter, verse) {
        const db = await this.db;
        const codes = Array.isArray(bookCodes) ? bookCodes : [bookCodes];
        if (codes.length === 0) return 0;
        const placeholders = codes.map(() => '?').join(',');
        const row = await db.get(
            `SELECT COUNT(DISTINCT commentaryId) AS cnt FROM CommentaryChapterVerse
             WHERE bookId IN (${placeholders}) AND chapterNumber = ? AND number = ?`,
            [...codes, chapter, verse]
        );
        return row?.cnt ?? 0;
    }
}

export const fathersWrapper = new FathersWrapper();
export const personsWrapper = new PersonsWrapper();
export const placesWrapper = new PlacesWrapper();
export const dictionaryWrapper = new DictionaryWrapper();
export const crossRefWrapper = new CrossRefWrapper();
export const categoriesWrapper = new CategoriesWrapper();
export const commentaryWrapper = new CommentaryWrapper();
