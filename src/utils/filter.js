function swearWordFilter(text) {
    const bannedWordPattern = /fuck|shit|damn|bitch|poop|ass|penis|crap|whore|wtf|nigg|fagg|retar/gi; 

    return text.replace(bannedWordPattern, (match) => '#'.repeat(match.length)); // For the length of the word replace it with #
}

module.exports = swearWordFilter;