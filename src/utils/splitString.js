// Splits a string into chunks at word boundaries, each under `limit` chars.
// Safeguards:
//   1. A word ≥ limit used to infinite-loop (inner loop couldn't consume it);
//      now the oversize word is hard-truncated with an ellipsis.
//   2. Off-by-one fixed: words that exactly equal the remaining budget now fit
//      in the current chunk rather than spilling to the next.
function splitString(str, limit = 2000) {
    const arr = [];
    const words = str.split(' ');
    let i = 0;
    while (i < words.length) {
        if (words[i].length >= limit) {
            arr.push(words[i].substring(0, limit - 1) + '…');
            i++;
            continue;
        }
        let tempStr = '';
        while (i < words.length && tempStr.length + words[i].length + (tempStr ? 1 : 0) <= limit) {
            tempStr += (tempStr ? ' ' : '') + words[i];
            i++;
        }
        arr.push(tempStr);
    }
    return arr;
}

export default splitString;
