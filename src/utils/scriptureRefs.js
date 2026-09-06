import { getBookId, toCanonical } from './bookNames.js';

// Scripture-reference detector. Used by message context-menu commands
// ("Look up scripture"), by passive detection (reacting to messages
// containing verse references), and anywhere else we need to find
// "John 3:16" / "1 Cor 13" / "Rom. 8:28" inside free text.
//
// Forms handled (non-exhaustive):
//   "John 3:16"                -> verse reference
//   "John 3:16-17"             -> verse range
//   "John 3"                   -> chapter only (startVerse/endVerse null)
//   "1 John 1:1" / "1John 1:1" -> numeric prefix, with or without space
//   "I John 1:1" / "II Cor 5"  -> Roman-numeral prefix
//   "Rom. 8:28" / "1 Jn. 1:1"  -> abbreviated book w/ trailing period
//   "Song of Solomon 2:1"      -> multi-word book name
//   "Acts 3:15, 4:33, 17:31"   -> continuation list, book carries across
//   "Acts 3:15, 26; 4:33"      -> bare 26 inherits chapter 3
//
// Design: the book-name part of the regex is deliberately permissive — we
// accept any word shape that could plausibly be a book, then validate with
// getBookId (silent mode) and discard anything that isn't a real book.
// That way we don't have to maintain a second alternation list that drifts
// from BOOKS. Trade-off: a name like "Dan" matches Daniel even when "Dan"
// is a person's name — callers that care must filter by context.
//
// Ranges: accepts hyphen, en-dash (U+2013), and em-dash (U+2014).
// Cross-chapter ranges (e.g., "John 3:16-4:2") are not supported in v1 —
// the second ":" would anchor the parse ambiguously. Caller treats such
// inputs as two separate refs if needed.
const SCRIPTURE_REGEX = /\b(?:([1-3]|I{1,3})\s*)?([A-Za-z]+(?:\s+of\s+[A-Za-z]+)?)\.?\s+(\d+)(?:\s*:\s*(\d+)(?:\s*[-–—]\s*(\d+))?)?\b/g;

// CONTINUATION lists — the standard citation shorthand where one book name
// carries across several references:
//
//   "Acts 3:15, 3:26, 4:33, 17:31"   comma-separated chapter:verse pairs
//   "Acts 3:15, 26; 4:33; 17:31"     bare 26 means "still chapter 3"
//   "Rom 8:28, 31-32"                a bare range, still chapter 8
//   "John 1; 3; 5"                   chapter-only anchor, so bare = chapter
//
// Sticky (/y) so it can only match IMMEDIATELY after the previous reference.
// A global regex would happily pair a book at the top of a message with a
// number at the bottom.
//
// A bare number's meaning depends on the reference before it: after "3:15" it
// is a verse in chapter 3, after a chapter-only "John 1" it is another chapter.
// That mirrors how the notation is actually read.
const CONTINUATION_REGEX = /\s*[,;]\s*(\d+)(?:\s*:\s*(\d+))?(?:\s*[-–—]\s*(\d+))?/y;

// Sanity bounds for continuations only, NOT for book-anchored references.
// A number after a comma is ambiguous — "John 3:16, 2020 was hard" would
// otherwise parse "2020" as a verse. Psalms has 150 chapters and Psalm 119 has
// 176 verses, so nothing real exceeds these, while years and counts do.
//
// Deliberately not applied to the anchored path: "John 3:999" has an explicit
// book and colon, so it is unambiguously a (wrong) reference rather than prose,
// and rejecting it here would change long-standing behaviour.
const MAX_CONTINUATION_CHAPTER = 150;
const MAX_CONTINUATION_VERSE = 176;

// Books with exactly one chapter. Their references are conventionally written
// WITHOUT it — "Jude 5" is how Jude 1:5 is normally cited, and the chapter-ful
// form is the rarer of the two.
//
// Read literally, "Jude 5" is chapter 5 of a book that has one chapter, so the
// lookup returns nothing. That failed silently everywhere this parser is used:
// passive detection posted no card at all, and the AI's reference tools
// answered "that's a chapter, not a verse — try Jude 5:1", advice that cannot
// work because there is no chapter 5 to put a verse in.
//
// The remap is driven by impossibility rather than preference: in a one-chapter
// book any number ABOVE 1 cannot be a chapter, so it must be a verse. "Jude 1"
// alone is deliberately left as a chapter reference — both readings are
// defensible there, and the chapter IS the whole book, which is the more useful
// of the two. "Jude 1:1" still names the verse explicitly.
//
// A RANGE overrides even that: "Obadiah 1-3" cannot be a chapter range, since
// the book has no chapters 2 or 3, so a bare 1 in front of a dash is a verse.
// Getting this wrong showed the entire book to someone who asked for three
// verses, because the bare 1 kept its chapter reading and the "-3" was then
// never read at all.
//
// The verse counts bound it for the same reason continuations are bounded:
// without a ceiling, "I've read Philemon 30 times" becomes a citation. Both the
// membership of this list and the counts are derived from bible.db in
// tests/singleChapterBooks.test.js — including the completeness check that no
// one-chapter book is missing — so they come from the data, not from memory.
export const SINGLE_CHAPTER_BOOKS = new Map([
    [31, 21],   // Obadiah
    [57, 25],   // Philemon
    [63, 13],   // 2 John
    [64, 14],   // 3 John
    [65, 25],   // Jude
]);

// The "-7" of "Jude 5-7": a verse range written without a colon, which the main
// regex only accepts after one. Consulted ONLY for single-chapter books, where
// the number before the dash has already been established as a verse — for every
// other book "John 3-5" is a chapter range and stays unsupported. Sticky, so it
// can only match immediately after the reference that anchors it.
const BARE_RANGE_REGEX = /\s*[-–—]\s*(\d+)/y;

/**
 * Normalize a slash command's book/chapter/verse options for a one-chapter book.
 *
 * The free-text parser cannot help here: slash commands never build a reference
 * string, they read `chapter` and `verse` as separate typed options and go
 * straight to the database. So "/bible book:Jude chapter:5" asked for chapter 5
 * of a book with one chapter and got nothing back, exactly as "Jude 5" did in a
 * message.
 *
 * Two corrections, because Discord asked the user an explicit question and the
 * answer can be wrong in two different ways:
 *
 *   1. The chapter of a one-chapter book is ALWAYS 1, whatever was typed. This
 *      alone fixes "chapter:5 verse:2" -> Jude 1:2.
 *   2. A chapter above 1 with NO verse is the ordinary citation shorthand, so
 *      that number is the verse: "chapter:5" -> Jude 1:5.
 *
 * A chapter past the book's last verse ("chapter:40" for 25-verse Jude) can
 * only be a mistake, so it falls through to rule 1 and shows the chapter — the
 * book the user actually named — rather than nothing.
 *
 * Returns the values unchanged for every multi-chapter book, and preserves the
 * caller's original `chapter` value (string or number) when nothing is remapped,
 * so command call sites keep whatever type they already passed downstream.
 *
 * @param {number} bookId
 * @param {string|number} chapter
 * @param {number|null} startVerse
 * @param {number|null} endVerse
 * @returns {{chapter: string|number, startVerse: number|null, endVerse: number|null, remapped: boolean}}
 */
export function resolveSingleChapterRef(bookId, chapter, startVerse = null, endVerse = null) {
    const verseCount = SINGLE_CHAPTER_BOOKS.get(bookId);
    const typed = Number.parseInt(String(chapter ?? '').trim(), 10);

    // Not a one-chapter book, or a chapter that needs no correction.
    if (verseCount === undefined || !Number.isFinite(typed) || typed <= 1) {
        return { chapter, startVerse, endVerse, remapped: false };
    }

    if (startVerse == null && typed <= verseCount) {
        return { chapter: 1, startVerse: typed, endVerse: endVerse ?? typed, remapped: true };
    }
    return { chapter: 1, startVerse, endVerse, remapped: true };
}

/**
 * Resolve the book from a match's optional numeric/Roman prefix and book word.
 *
 * The prefix group is greedy, so a book whose NAME begins with I gets split:
 * "Isa 53:3" matches as prefix "I" + word "sa", and "I Sa" is a real
 * abbreviation for 1 Samuel — so Isaiah silently became 1 Samuel, and
 * "Isaiah 53" ("I" + "saiah") resolved to nothing at all and was dropped.
 *
 * The fix is to ask whether the prefix was written AGAINST the book word or
 * apart from it:
 *
 *   "Isa"    contiguous -> try "Isa" first   -> Isaiah
 *   "I Sa"   separated  -> only "I Sa"       -> 1 Samuel
 *   "1John"  contiguous -> try "1John" first -> 1 John
 *   "1 John" separated  -> only "1 John"     -> 1 John
 *
 * Only the contiguous case gets the joined reading, because joining across a
 * space the author actually typed would be inventing a name they didn't write.
 * The spaced reading stays as the fallback, so compact forms whose joined
 * spelling isn't a known alias ("IJohn") still resolve.
 */
function resolveBook(raw, prefix, bookWord) {
    if (!prefix) return getBookId(bookWord, { silent: true });

    // raw always begins with the prefix; what follows it is either the book
    // word (contiguous) or the whitespace that separated them.
    const contiguous = /^[A-Za-z]/.test(raw.slice(prefix.length));
    if (contiguous) {
        const joined = getBookId(`${prefix}${bookWord}`, { silent: true });
        if (joined) return joined;
    }
    return getBookId(`${prefix} ${bookWord}`, { silent: true });
}

/**
 * Parse Bible references out of a block of text.
 * @param {string} text
 * @returns {Array<{bookId:number, bookName:string, chapter:number, startVerse:number|null, endVerse:number|null, raw:string}>}
 */
export function parseScriptureRefs(text) {
    if (!text || typeof text !== 'string') return [];
    // Clamp before scanning. A single Discord message is ~4000 chars, but the
    // reaction path (extractSearchText) concatenates embeds + nested V2 text and
    // can exceed that. The rewind loop is O(n·m) worst case; bounding n keeps an
    // adversarially crafted blob from costing more than a couple ms.
    if (text.length > 8000) text = text.slice(0, 8000);

    const results = [];
    // Manual exec loop (not matchAll) because we rewind lastIndex on validation
    // failure: a regex match like "and 1" (from "and 1 Cor 13:4-7") fails the
    // getBookId check, and matchAll would advance past the whole failed match,
    // eating the "1" that belongs to "1 Cor". Rewinding to match.index + 1
    // lets the engine pick up "1 Cor 13:4-7" on the next scan.
    SCRIPTURE_REGEX.lastIndex = 0;
    let match;
    while ((match = SCRIPTURE_REGEX.exec(text)) !== null) {
        const [raw, prefix, bookWord, chapterStr, startStr, endStr] = match;

        const bookId = resolveBook(raw, prefix, bookWord);
        if (!bookId) {
            SCRIPTURE_REGEX.lastIndex = match.index + 1;
            continue;
        }

        const chapter = parseInt(chapterStr, 10);
        if (!Number.isFinite(chapter) || chapter < 1) {
            SCRIPTURE_REGEX.lastIndex = match.index + 1;
            continue;
        }

        let startVerse = null;
        let endVerse = null;
        let rejected = false;
        if (startStr !== undefined) {
            startVerse = parseInt(startStr, 10);
            if (!Number.isFinite(startVerse) || startVerse < 1) {
                rejected = true;
            } else {
                endVerse = startVerse;
                if (endStr !== undefined) {
                    endVerse = parseInt(endStr, 10);
                    if (!Number.isFinite(endVerse) || endVerse < startVerse) {
                        rejected = true;
                    }
                }
            }
        }
        if (rejected) {
            SCRIPTURE_REGEX.lastIndex = match.index + 1;
            continue;
        }

        // "Jude 5" means verse 5 of the book's only chapter. Applies only when
        // no colon was written — "Jude 1:5" already says what it means.
        // See SINGLE_CHAPTER_BOOKS.
        let effectiveChapter = chapter;
        let rawText = raw;
        const verseCount = SINGLE_CHAPTER_BOOKS.get(bookId);
        if (verseCount !== undefined && startStr === undefined) {
            // Look for a bare range BEFORE deciding what the number is, because
            // the range is what settles the one genuinely ambiguous case.
            BARE_RANGE_REGEX.lastIndex = SCRIPTURE_REGEX.lastIndex;
            const rangeMatch = BARE_RANGE_REGEX.exec(text);
            const rangeEnd = rangeMatch ? parseInt(rangeMatch[1], 10) : NaN;
            const hasRange = Number.isFinite(rangeEnd) && rangeEnd >= chapter && rangeEnd <= verseCount;

            // A bare 1 stays a CHAPTER on its own — "Jude 1" is the whole book,
            // and both readings are defensible. But a range removes that
            // ambiguity: "Obadiah 1-3" cannot be a chapter range, because the
            // book has no chapters 2 or 3, so it has to be verses. Missing this
            // showed the whole book when someone asked for three verses.
            if (hasRange || chapter > 1) {
                if (chapter > verseCount) {
                    // Neither a chapter nor a verse this book has, so it isn't a
                    // reference at all — "I've read Philemon 30 times".
                    SCRIPTURE_REGEX.lastIndex = match.index + 1;
                    continue;
                }
                effectiveChapter = 1;
                startVerse = chapter;
                endVerse = hasRange ? rangeEnd : chapter;

                // Consume the range so the scanner cannot re-read "3" as a
                // reference of its own.
                if (hasRange) {
                    rawText = raw + rangeMatch[0];
                    SCRIPTURE_REGEX.lastIndex = BARE_RANGE_REGEX.lastIndex;
                }
            }
        }

        const bookName = toCanonical(bookId);
        results.push({
            bookId,
            bookName,
            chapter: effectiveChapter,
            startVerse,
            endVerse,
            raw: rawText.trim(),
        });

        // Consume any continuation list hanging off this reference. Advances
        // the main scanner past whatever it takes, so "4:33" in
        // "Acts 3:15, 4:33" is never re-examined as a standalone fragment.
        SCRIPTURE_REGEX.lastIndex = consumeContinuations(
            text, SCRIPTURE_REGEX.lastIndex,
            { bookId, bookName, chapter: effectiveChapter, hasVerse: startVerse !== null },
            results
        );
    }

    return dedupeRefs(results);
}

/**
 * Walk a comma/semicolon-separated continuation list following a reference,
 * pushing each entry onto `results`. Returns the index to resume scanning from.
 *
 * Context carries forward as it does when a human reads the notation: the book
 * always, and the chapter until an entry names a new one. Stops at the first
 * entry that doesn't parse or fails the sanity bounds rather than skipping it —
 * once the list stops looking like a citation, the rest is prose.
 */
function consumeContinuations(text, startIndex, context, results) {
    const { bookId, bookName } = context;
    const singleChapterVerses = SINGLE_CHAPTER_BOOKS.get(bookId);
    let chapter = context.chapter;
    let hasVerse = context.hasVerse;
    let cursor = startIndex;

    for (;;) {
        CONTINUATION_REGEX.lastIndex = cursor;
        const match = CONTINUATION_REGEX.exec(text);
        if (!match) break;

        const [rawMatch, firstStr, secondStr, rangeStr] = match;

        // A bare 1, 2 or 3 might not be a verse at all — it might be the
        // numeric prefix of the NEXT book: "1 Cor 6:14; 1 Cor 15:1-58" would
        // otherwise read the second "1" as a verse in chapter 6 and swallow the
        // book name behind it, losing 1 Cor 15 entirely. If a book-shaped
        // reference follows, stop and let the main scanner have it.
        if (secondStr === undefined && rangeStr === undefined && /^[1-3]$/.test(firstStr)) {
            const rest = text.slice(CONTINUATION_REGEX.lastIndex);
            if (/^\s*[A-Za-z]+\.?\s*\d/.test(rest)) break;
        }

        let nextChapter;
        let nextStart = null;
        let nextEnd = null;

        if (secondStr !== undefined) {
            // "4:33" — names its own chapter.
            nextChapter = parseInt(firstStr, 10);
            nextStart = parseInt(secondStr, 10);
            nextEnd = rangeStr !== undefined ? parseInt(rangeStr, 10) : nextStart;
        } else if (hasVerse) {
            // "26" following "3:15" — a verse in the chapter still in context.
            nextChapter = chapter;
            nextStart = parseInt(firstStr, 10);
            nextEnd = rangeStr !== undefined ? parseInt(rangeStr, 10) : nextStart;
        } else if (singleChapterVerses !== undefined) {
            // "Obadiah 1, 3" — the book has no chapter 3, so the bare number is
            // a verse in the only chapter there is.
            nextChapter = 1;
            nextStart = parseInt(firstStr, 10);
            nextEnd = rangeStr !== undefined ? parseInt(rangeStr, 10) : nextStart;
        } else {
            // "3" following a chapter-only "John 1" — another chapter.
            nextChapter = parseInt(firstStr, 10);
            if (rangeStr !== undefined) break;   // "John 1, 3-5" is a chapter range; not supported
        }

        // A one-chapter book bounds itself far more tightly than the generic
        // ceilings can: it has no second chapter, and its last verse is known.
        const chapterCeiling = singleChapterVerses !== undefined ? 1 : MAX_CONTINUATION_CHAPTER;
        const verseCeiling = singleChapterVerses ?? MAX_CONTINUATION_VERSE;

        if (!Number.isFinite(nextChapter) || nextChapter < 1 || nextChapter > chapterCeiling) break;
        if (nextStart !== null) {
            if (!Number.isFinite(nextStart) || nextStart < 1 || nextStart > verseCeiling) break;
            if (!Number.isFinite(nextEnd) || nextEnd < nextStart || nextEnd > verseCeiling) break;
        }

        results.push({
            bookId,
            bookName,
            chapter: nextChapter,
            startVerse: nextStart,
            endVerse: nextEnd,
            // The separator isn't part of the reference a user would recognise.
            raw: rawMatch.replace(/^\s*[,;]\s*/, '').trim(),
        });

        chapter = nextChapter;
        hasVerse = nextStart !== null;
        cursor = CONTINUATION_REGEX.lastIndex;
    }

    return cursor;
}

// Two parses at the same (bookId, chapter, startVerse, endVerse) coordinate
// are redundant — users don't want to see the same ref twice just because
// the text contained both "John 3:16" and "Jn 3:16". Keep the first match.
function dedupeRefs(refs) {
    const seen = new Set();
    const out = [];
    for (const r of refs) {
        const key = `${r.bookId}:${r.chapter}:${r.startVerse ?? ''}:${r.endVerse ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}
