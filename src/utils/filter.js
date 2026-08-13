function swearWordFilter(text) {
    const bannedWordPattern = /\b(?:fuck|shit|damn|bitch|poop|ass|penis|crap|whore|wtf|nigg|fagg|retar)\b/gi;

    return text.replace(bannedWordPattern, (match) => '#'.repeat(match.length));
}

// Escape Discord markdown meta-characters in text that will be reflected back
// into embed/container content. Use whenever user input is interpolated into a
// TextDisplayBuilder / embed description — prevents a crafted query from
// injecting **bold**, [link](url), spoilers, etc. into the response.
export function escapeMarkdown(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/([\\*_`~|>#\[\]()])/g, '\\$1');
}

// Private-use-area and zero-width codepoints. Models use these as invisible
// delimiters around internal markup; Discord has no glyph for them and renders
// each as an empty box.
const INVISIBLE_MARKUP = '[\\uE000-\\uF8FF\\u200B-\\u200F\\uFEFF]';

// entity["book","The Great Divorce","cs lewis 1945"] — with the delimiters
// above wrapped around "entity" and the closing bracket. Group 1 is the
// human-readable name (the SECOND array element; the first is a type tag).
const ENTITY_TOKEN = new RegExp(
    `${INVISIBLE_MARKUP}*entity${INVISIBLE_MARKUP}*\\[\\s*"[^"]*"\\s*,\\s*"([^"]*)"[^\\]]*\\]${INVISIBLE_MARKUP}*`,
    'gi'
);

// Any remaining entity token whose shape we don't recognise — drop it whole
// rather than leak boxes.
const ENTITY_TOKEN_FALLBACK = new RegExp(
    `${INVISIBLE_MARKUP}*entity${INVISIBLE_MARKUP}*\\[[^\\]]*\\]${INVISIBLE_MARKUP}*`,
    'gi'
);

/**
 * Strip model-internal markup that leaks into user-visible text.
 *
 * GPT-5.6-Luna annotates some entities with a structured citation token wrapped
 * in invisible delimiters, expecting a client that renders it richly. Discord is
 * not that client: it shows an empty box per delimiter, so a reply about C.S.
 * Lewis rendered as
 *
 *   ...higher tribunal than him" (▯entity▯["book","The Great Divorce","cs lewis 1945"]▯).
 *
 * gpt-4o-mini never emitted these, so this arrived with the model swap.
 *
 * Recovers the readable name where possible ("The Great Divorce") rather than
 * deleting the whole token, since the model usually put it there to cite a real
 * source and the sentence reads as a dangling parenthetical without it.
 *
 * Written against the codepoint RANGE rather than the specific delimiter, so a
 * different invisible marker in a future model revision is still caught.
 */
export function stripModelMarkup(text) {
    if (text === null || text === undefined) return '';
    const cleaned = String(text)
        .replace(ENTITY_TOKEN, '$1')
        .replace(ENTITY_TOKEN_FALLBACK, '')
        // Anything invisible left over, wherever it came from.
        .replace(new RegExp(INVISIBLE_MARKUP, 'g'), '')
        // Removals can leave "( )" or doubled spaces behind.
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?)])/g, '$1');
    return cleaned;
}

// A sentence end, allowing for a closing quote/bracket after the punctuation
// ("...he said." / "(Rom 16:1-2)."), and requiring whitespace or end-of-string
// after it so a verse reference like "Gal 1:8" or an abbreviation is not
// mistaken for the end of a thought.
const SENTENCE_END = /[.!?][)\]"'”’]*(?=\s|$)/g;

// Below this share of the original, trimming has cut too much to be an
// improvement — a user staring at one orphaned sentence is worse served than
// one who can see the answer was cut off mid-word. Chosen rather than a fixed
// character count because the cost is proportional: losing 40% of a long answer
// and 40% of a short one are equally bad trades.
const MIN_KEEP_RATIO = 0.6;

/**
 * Cut a response back to its last COMPLETE sentence.
 *
 * For answers the model stopped writing because it ran out of output tokens
 * (finish_reason 'length'), which land mid-word — "...and finally **Evangel".
 * A clean stop reads as a short answer; a dangling fragment reads as a bug.
 *
 * Returns the text unchanged when trimming would remove too much, or when
 * there is no sentence boundary to fall back to at all. That is deliberate:
 * this is a cosmetic repair, and it must never be the reason a user gets less
 * than the model actually produced.
 */
export function trimToLastCompleteSentence(text) {
    if (text === null || text === undefined) return '';
    const str = String(text).trimEnd();
    if (!str) return '';

    let lastEnd = -1;
    for (const match of str.matchAll(SENTENCE_END)) {
        lastEnd = match.index + match[0].length;
    }
    if (lastEnd <= 0) return str;

    const trimmed = str.slice(0, lastEnd).trimEnd();
    if (trimmed.length < str.length * MIN_KEEP_RATIO) return str;

    // An unpaired ** left behind by a bullet the model never finished would
    // otherwise bold the remainder of the message in Discord's renderer.
    const bolds = (trimmed.match(/\*\*/g) ?? []).length;
    return bolds % 2 === 0 ? trimmed : trimmed.replace(/\*\*(?![\s\S]*\*\*)/, '');
}

export default swearWordFilter;
