const path = require('path');
const sqlite3 = require('sqlite3')
const { open } = require('sqlite');
const books = require('../../data/books.json');
const logger = require('./logger');

const numSuperMap = new Map([
    [0, '⁰'],
    [1, '¹'],
    [2, '²'],
    [3, '³'],
    [4, '⁴'],
    [5, '⁵'],
    [6, '⁶'],
    [7, '⁷'],
    [8, '⁸'],
    [9, '⁹']
]);

/**
 * 
 * @param {number} number Number to convert to superscript
 * @returns {string} The superscripted number
 * 
 * @example
 * numberToSuperScript(123) // returns ¹²³
 */
const numberToSuperScript = (number) => {
    let superScript = '';

    for (const digit of number.toString()) {
        superScript += numSuperMap.get(parseInt(digit));
    }

    return superScript;
}

/*
const booksToName = new Map([
    ["gen", "Genesis"],
    ["exo", "Exodus"],
    ["lev", "Leviticus"],
    ["num", "Numbers"],
    ["deu", "Deuteronomy"],
    ["jos", "Joshua"],
    ["jdg", "Judges"],
    ["rut", "Ruth"],
    ["1sa", "1 Samuel"],
    ["2sa", "2 Samuel"],
    ["1ki", "1 Kings"],
    ["2ki", "2 Kings"],
    ["1ch", "1 Chronicles"],
    ["2ch", "2 Chronicles"],
    ["ezr", "Ezra"],
    ["neh", "Nehemiah"],
    ["est", "Esther"],
    ["job", "Job"],
    ["psa", "Psalms"],
    ["pro", "Proverbs"],
    ["ecc", "Ecclesiastes"],
    ["sos", "Song of Solomon"],
    ["isa", "Isaiah"],
    ["jer", "Jeremiah"],
    ["lam", "Lamentations"],
    ["eze", "Ezekiel"],
    ["dan", "Daniel"],
    ["hos", "Hosea"],
    ["joe", "Joel"],
    ["amo", "Amos"],
    ["oba", "Obadiah"],
    ["jon", "Jonah"],
    ["mic", "Micah"],
    ["nah", "Nahum"],
    ["hab", "Habakkuk"],
    ["zep", "Zephaniah"],
    ["hag", "Haggai"],
    ["zec", "Zechariah"],
    ["mal", "Malachi"],
    ["mat", "Matthew"],
    ["mar", "Mark"],
    ["luk", "Luke"],
    ["joh", "John"],
    ["act", "Acts"],
    ["rom", "Romans"],
    ["1co", "1 Corinthians"],
    ["2co", "2 Corinthians"],
    ["gal", "Galatians"],
    ["eph", "Ephesians"],
    ["php", "Philippians"],
    ["col", "Colossians"],
    ["1th", "1 Thessalonians"],
    ["2th", "2 Thessalonians"],
    ["1ti", "1 Timothy"],
    ["2ti", "2 Timothy"],
    ["tit", "Titus"],
    ["phm", "Philemon"],
    ["heb", "Hebrews"],
    ["jam", "James"],
    ["1pe", "1 Peter"],
    ["2pe", "2 Peter"],
    ["1jo", "1 John"],
    ["2jo", "2 John"],
    ["3jo", "3 John"],
    ["jde", "Jude"],
    ["rev", "Revelation"]
]);*/

const bible = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'bible.db');

    const db = await open({
        filename: filePath,
        driver: sqlite3.Database,
        readOnly: true
    });

    return db;
})();

const strongs = (async () => {
    const filePath = path.join(__dirname, '../..', 'data', 'strongs.db');

    const db = await open({
        filename: filePath,
        driver: sqlite3.Database,
        readOnly: true
    });

    return db;
})();

class bibleWrapper {
    constructor() {
        this.db = bible;
    }

    /**
     * (Use getVerses). This is to get a single verse from database. For most people you should use the getVerses method instead
     * @param {*} book  The book to get verses from (Number)
     * @param {*} chapter  The chapter to get verses from
     * @param {*} startVerse  The start verse to get
     * @param {*} table  The table to get verses from (default is bsb)
     * @returns A array of text objects with the text of the verses
     * @deprecated
     */
    async getVerse (book, chapter, verse) {
        const db = await this.db;
        const query = await db.get(`SELECT * FROM english WHERE book = ? AND chapter = ? AND verse = ?`, [book, chapter, verse]);

        /*const replacementCharacterRegex = /�/g;

        for (let i = 0; i < query.length; i++) {
            query[i].text = query[i].text.replace(replacementCharacterRegex, '');
        }*/

        return query;
    }

        /**
     *   Use this method to get a verse from the bible database
     * @param {*} book  The book to get verses from (Number)
     * @param {*} chapter  The chapter to get verses from
     * @param {*} startVerse  The start verse to get
     * @param {*} endVerse  The end verse to get
     * @param {*} table  The table to get verses from (default is bsb)
     * @returns A array of text objects with the text of the verses
     */
    async getVerses (book, chapter, startVerse, endVerse) {
        const db = await this.db;

        const query = await db.all(`SELECT * FROM english WHERE bookID = ? AND chapter = ? AND verse BETWEEN ? AND ?`, [book, chapter, startVerse, endVerse]);
        /*const replacementCharacterRegex = /�/g;
    
        for (let i = 0; i < query.length; i++) {
            query[i].text = query[i].text.replace(replacementCharacterRegex, '');
        }*/

        return query;
    }

      /**
   * 
   * @param {*} book  (Number)
   * @param {*} chapter 
   * @param {*} verse 
   * @returns 
   */
    async getInterlinearVerse (book, chapter, verse) {
        const db = await this.db;

        const query = await db.get(`SELECT * FROM interlinear WHERE bookid = ? AND chapter = ? AND verse = ?`, [book, chapter, verse]);
        
        return query;
    }

}

class strongsWrapper {
    constructor() {
        this.db = strongs;
    }

    /**
     * Use this method to get a word object from the strongs database using the unicode
     * @param {*} language  The language to search for the word in (Hebrew or Greek)
     * @param {*} unicode  The unicode to search for
     * @returns  The word object
     * @deprecated
     */
    async getStrongsUnicode (language, unicode) {
        const db = await this.db;

        const query = await db.get(`SELECT * FROM ${language} WHERE unicode = ?`, [unicode]);

        return query;
    }

    /**
     * Use this method to get a word object from the strongs database using the english then it uses the closest match algorithm to find the closest match
     * @param {*} language  The language to search for the word in (Hebrew or Greek)
     * @param {*} english  The english to search for
     * @returns  The word object
     */
    async getStrongsEnglish (language, english) {
        const db = await this.db;

        const query = await db.all(`SELECT * FROM ${language} WHERE kjvdef LIKE ?`, [`%${english}%`]);
        if (query.length == 0) return null;
        
        return query; 
    }

    /**
     * Use this method to get a word object from the strongs database using the strongs id
     * @param {*} language  The language to search for the word in (Hebrew or Greek)
     * @param {*} id  The strongs id to search for
     * @returns  The word object
     */
    async getStrongsId (language, id) {
        const db = await this.db;
        const query = await db.get(`SELECT * FROM ${language} WHERE strongs = ?`, [id]);

        return query;
    }

}

// Helper function to do case-insensitive map lookup
function getBookId(bookName) {
    if (!bookName) return null;
    
    // Normalize input: lowercase and handle spaces consistently
    const lowercaseInput = bookName.toLowerCase().trim();
    const noSpaceInput = lowercaseInput.replace(/\s+/g, '');
    const normalizedInput = lowercaseInput.replace(/\s+/g, ' ');
    
    logger.info(`[Book Lookup] Input variations:
        Original: "${bookName}"
        Lowercase: "${lowercaseInput}"
        No Space: "${noSpaceInput}"
        Normalized: "${normalizedInput}"`);

    // Try common abbreviations first since it's more reliable
    const commonAbbreviations = {
        // Old Testament
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
        
        // New Testament
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

    // Add additional logging for Peter-specific debugging
    if (lowercaseInput.includes('peter') || lowercaseInput.includes('pet')) {
        logger.info(`[Book Lookup] Peter-related input detected:
            Input: ${lowercaseInput}
            No Space: ${noSpaceInput}
            Normalized: ${normalizedInput}
            Direct Match: ${commonAbbreviations[lowercaseInput]}
            No Space Match: ${commonAbbreviations[noSpaceInput]}
            Normalized Match: ${commonAbbreviations[normalizedInput]}`);
    }

    // Try all input variations in common abbreviations
    const commonId = commonAbbreviations[lowercaseInput] || 
                    commonAbbreviations[noSpaceInput] || 
                    commonAbbreviations[normalizedInput];
    
    if (commonId) {
        logger.info(`[Book Lookup] Found in common abbreviations:
            Matched Input: ${commonId === commonAbbreviations[lowercaseInput] ? lowercaseInput : 
                           commonId === commonAbbreviations[noSpaceInput] ? noSpaceInput : normalizedInput}
            ID: ${commonId}`);
        return commonId;
    } else {
        logger.info(`[Book Lookup] Not found in common abbreviations. Tried:
            Lowercase: ${lowercaseInput} -> ${commonAbbreviations[lowercaseInput]}
            No Space: ${noSpaceInput} -> ${commonAbbreviations[noSpaceInput]}
            Normalized: ${normalizedInput} -> ${commonAbbreviations[normalizedInput]}`);
    }

    // Try Map lookup with case-insensitive comparison
    for (const [key, value] of module.exports.books) {
        if (key.toLowerCase() === lowercaseInput || 
            key.toLowerCase() === noSpaceInput || 
            key.toLowerCase() === normalizedInput) {
            logger.info(`[Book Lookup] Found in books Map: ${value}`);
            return parseInt(value);
        }
    }

    // Try fuzzy matching for common misspellings
    const fuzzyMatches = {
        'revelations': 66,
        'revalation': 66,
        'revelaton': 66,
        'revelatons': 66,
        'revalations': 66
    };

    const fuzzyId = fuzzyMatches[lowercaseInput];
    if (fuzzyId) {
        logger.info(`[Book Lookup] Found fuzzy match: ${fuzzyId}`);
        return fuzzyId;
    }

    // Try numbersToBook Map with case-insensitive comparison
    const numbersToBookMap = module.exports.numbersToBook;
    for (const [id, name] of numbersToBookMap.entries()) {
        if (name.toLowerCase() === lowercaseInput || 
            name.toLowerCase() === noSpaceInput || 
            name.toLowerCase() === normalizedInput) {
            logger.info(`[Book Lookup] Found in numbersToBook: ${id}`);
            return id;
        }
    }
    
    logger.warn(`[Book Lookup] No match found for book: "${lowercaseInput}"`);
    return null;
}

/**
 * A list of client methods!
 */
module.exports = {
    /**
     * A function for converting numbers into superscript (even multiple digit ones!)
     */
    numberToSuperScript: numberToSuperScript,

    /**
     * A map representing a list of book abbreviations
     */
    books: new Map(Object.entries(books)),

    /**
     * A map representing a list of book numbers
    **/
    numbersToBook: new Map([
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
    ]),

    // instantiate in order to maintain state and not have to open a new connection every time
    strongsWrapper: new strongsWrapper(),

    bibleWrapper: new bibleWrapper(), 

    getBookId,
}