/**
 * split the string so that it doesn't exceed the character limit also make sure it doesnt split mid word
 * @param {String} str - The string to split
 * @returns {Array} - The array of strings representing the split string to proper size
 *  */ 
function splitString(str, limit = 2000) {
    let arr = [];
    let words = str.split(' ');
    let i = 0;
    while (i < words.length) {
        let tempStr = '';
        while (i < words.length && (tempStr.length + words[i].length) < limit) { // 2000 is the max character limit and add words until it reaches the limit
            tempStr += words[i] + ' ';
            i++;
        }

        /*if (tempStr.includes(">>>")) {
            if (words[i]) {
                words[i] = ">>> " + words[i];
            }
        }*/ //Wtf is this for?

        arr.push(tempStr.trim());
    }

    return arr;
}

module.exports = splitString;