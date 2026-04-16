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

class FathersWrapper {
    constructor() { this.db = fathersPromise; }

    async getByPassage(books, chapter, verse, fatherFilter = null) {
        const db = await this.db;
        const bookList = Array.isArray(books) ? books : [books];
        const loc = chapter * 1_000_000 + verse;
        const placeholders = bookList.map(() => '?').join(',');
        const params = [...bookList, loc, loc];
        let sql = `SELECT father_name, txt, source_url, source_title, location_start, location_end
                   FROM commentary
                   WHERE book IN (${placeholders}) AND location_start <= ? AND location_end >= ?`;
        if (fatherFilter) {
            sql += ` AND father_name LIKE ?`;
            params.push(`%${fatherFilter}%`);
        }
        sql += ` ORDER BY father_name LIMIT 50`;
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

    /**
     * Two-tier search: exact term match first, then fallback to definition full-text.
     * @returns {Promise<{results: Array, matchType: 'exact' | 'definition'}>}
     */
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

        // Shortest-definition-first bubbles up concise hits over long tangential mentions
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

// Commentary DB stores some books under both singular/plural forms (e.g., psalms/psalm).
// Returns the normalized lowercase-compact form(s) to query for a canonical book name.
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
