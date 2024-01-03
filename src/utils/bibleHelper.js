const path = require('path');
const sqlite3 = require('sqlite3')
const { open } = require('sqlite');
const books = require('../../data/books.json');

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
    books: new Map(books),

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
}