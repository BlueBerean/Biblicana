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

export default swearWordFilter;
