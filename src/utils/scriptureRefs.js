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

/**
 * Parse Bible references out of a block of text.
 * @param {string} text
 * @returns {Array<{bookId:number, bookName:string, chapter:number, startVerse:number|null, endVerse:number|null, raw:string}>}
 */
export function parseScriptureRefs(text) {
    if (!text || typeof text !== 'string') return [];

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

        const candidate = prefix ? `${prefix} ${bookWord}` : bookWord;
        const bookId = getBookId(candidate, { silent: true });
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

        results.push({
            bookId,
            bookName: toCanonical(bookId),
            chapter,
            startVerse,
            endVerse,
            raw: raw.trim(),
        });
    }

    return dedupeRefs(results);
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
