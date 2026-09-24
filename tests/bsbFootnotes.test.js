// The BSB's translator footnotes must reach the model.
//
// bible.db holds the BSB as plain verse text. Asked whether the BSB
// "tampered" with 2 Sam 21:19 by adding "the brother of", the bot could not see
// the BSB's own footnote disclosing exactly that, and guessed - once in each
// direction. data/bsb_footnotes.sqlite (src/buildBsbFootnotes.js) restores it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import log from 'loglevel';
log.setLevel('error');
const { bsbFootnotesWrapper } = await import('../src/utils/studyHelper.js');

test('2 Sam 21:19 carries the note disclosing the supplied words', async () => {
    const notes = await bsbFootnotesWrapper.getNotes(10, 21, 19);
    assert.ok(notes.some(n => /does not include the brother of/i.test(n.text)), JSON.stringify(notes));
});

test('a range returns notes for every verse in it, in order', async () => {
    const notes = await bsbFootnotesWrapper.getNotes(1, 1, 1, 6);
    assert.ok(notes.length >= 2);
    const verses = notes.map(n => n.verse);
    assert.deepEqual(verses, [...verses].sort((a, b) => a - b));
});

test('the footnotes file is optional: opened read-only and failure resolves null', async () => {
    // A missing data file must not crash startup; the code ships by git pull
    // and the file by scp, so for a moment one exists without the other.
    // readOnly:true is NOT an option the sqlite package reads - only mode is -
    // and without it a missing file would be silently CREATED empty.
    const src = await readFile(new URL('../src/utils/studyHelper.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const bsbFootnotesPromise'), src.indexOf('})();', src.indexOf('const bsbFootnotesPromise')));
    assert.match(block, /mode: sqlite3\.OPEN_READONLY/);
    assert.match(block, /catch \(err\)[\s\S]*return null/);
});
