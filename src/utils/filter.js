function swearWordFilter(text) {
    const bannedWordPattern = /\b(?:fuck|shit|damn|bitch|poop|ass|penis|crap|whore|wtf|nigg|fagg|retar)\b/gi; 

    return text.replace(bannedWordPattern, (match) => '#'.repeat(match.length)); // For the length of the word replace it with #
}

module.exports = swearWordFilter;