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

export default swearWordFilter;
