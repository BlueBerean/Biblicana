import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { parseScriptureRefs } from '../src/utils/scriptureRefs.js';

function one(text) {
    const refs = parseScriptureRefs(text);
    assert.equal(refs.length, 1, `expected 1 ref from "${text}", got ${refs.length}: ${JSON.stringify(refs)}`);
    return refs[0];
}

test('parses basic verse reference', () => {
    const r = one('John 3:16');
    assert.equal(r.bookId, 43);
    assert.equal(r.bookName, 'John');
    assert.equal(r.chapter, 3);
    assert.equal(r.startVerse, 16);
    assert.equal(r.endVerse, 16);
    assert.equal(r.raw, 'John 3:16');
});

test('parses verse range with ASCII hyphen', () => {
    const r = one('John 3:16-17');
    assert.equal(r.startVerse, 16);
    assert.equal(r.endVerse, 17);
});

test('parses verse range with en-dash and em-dash', () => {
    assert.equal(one('John 3:16\u201317').endVerse, 17);
    assert.equal(one('John 3:16\u201417').endVerse, 17);
});

test('parses chapter-only reference', () => {
    const r = one('Psalm 23');
    assert.equal(r.bookId, 19);
    assert.equal(r.chapter, 23);
    assert.equal(r.startVerse, null);
    assert.equal(r.endVerse, null);
});

test('parses numeric-prefix book with space', () => {
    const r = one('1 John 1:1');
    assert.equal(r.bookId, 62);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 1);
});

test('parses numeric-prefix book without space', () => {
    const r = one('1John 1:1');
    assert.equal(r.bookId, 62);
});

test('parses Roman-numeral prefix', () => {
    assert.equal(one('I John 1:1').bookId, 62);
    assert.equal(one('II Corinthians 5:17').bookId, 47);
    assert.equal(one('III John 1').bookId, 64);
});

test('parses abbreviated book with trailing period', () => {
    const r = one('Rom. 8:28');
    assert.equal(r.bookId, 45);
    assert.equal(r.raw, 'Rom. 8:28');  // raw preserves source text including period
});

test('parses abbreviated numeric-prefix book', () => {
    assert.equal(one('1 Jn. 1:1').bookId, 62);
    assert.equal(one('1 Cor. 13:4').bookId, 46);
});

test('parses multi-word book name "Song of Solomon"', () => {
    const r = one('Song of Solomon 2:1');
    assert.equal(r.bookId, 22);
    assert.equal(r.chapter, 2);
});

test('parses references with surrounding punctuation', () => {
    assert.equal(one('(John 3:16)').bookId, 43);
    assert.equal(one('see John 3:16.').bookId, 43);
    assert.equal(one('"John 3:16"').bookId, 43);
});

test('parses multiple distinct references in one string', () => {
    const refs = parseScriptureRefs('Read John 3:16 and Romans 8:28 and 1 Cor 13:4-7');
    assert.equal(refs.length, 3);
    assert.equal(refs[0].bookId, 43);
    assert.equal(refs[1].bookId, 45);
    assert.equal(refs[2].bookId, 46);
    assert.equal(refs[2].endVerse, 7);
});

test('deduplicates identical references', () => {
    const refs = parseScriptureRefs('John 3:16 is John 3:16');
    assert.equal(refs.length, 1);
});

test('ignores non-scripture prose', () => {
    assert.deepEqual(parseScriptureRefs('he likes pizza and cats very much'), []);
    assert.deepEqual(parseScriptureRefs('Hello world, how are you today'), []);
    assert.deepEqual(parseScriptureRefs(''), []);
    assert.deepEqual(parseScriptureRefs(null), []);
    assert.deepEqual(parseScriptureRefs(undefined), []);
});

test('rejects chapter 0 / verse 0 / end < start', () => {
    assert.deepEqual(parseScriptureRefs('John 0:5'), []);
    assert.deepEqual(parseScriptureRefs('John 3:0'), []);
    assert.deepEqual(parseScriptureRefs('John 3:16-10'), []);
});

test('handles case insensitivity', () => {
    assert.equal(one('john 3:16').bookId, 43);
    assert.equal(one('JOHN 3:16').bookId, 43);
    assert.equal(one('ROMANS 8:28').bookId, 45);
});

test('known false-positive: person-name "Dan" resolves to Daniel', () => {
    // Documented limitation. Callers that care (e.g., narrative text parsing)
    // must filter by context; the parser itself stays permissive so we don't
    // accidentally miss "Dan 2:44" when someone genuinely means Daniel.
    const r = one('Dan 12');
    assert.equal(r.bookId, 27);  // Daniel
    assert.equal(r.chapter, 12);
});

test('handles realistic Discord-like messages', () => {
    const refs = parseScriptureRefs("Just read John 3:16 — what a verse! Also see Rom. 5:8");
    assert.equal(refs.length, 2);
    assert.equal(refs[0].bookName, 'John');
    assert.equal(refs[1].bookName, 'Romans');
});

test('handles Song of Songs and Revelation spellings', () => {
    assert.equal(one('Song of Songs 4:7').bookId, 22);
    assert.equal(one('Revelation 21:4').bookId, 66);
});

// --- continuation lists ----------------------------------------------------
//
// One book name carrying across several references is how scripture is
// actually cited, and it is how Biblicana's own AI answers cite it — so
// without this the verse pager under an AI answer expanded only the first
// reference of a list.
//
// The meaning of a bare number depends on what came before it, which is the
// whole difficulty: after "3:15" it is a verse, after a chapter-only "John 1"
// it is a chapter.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

const coords = text => parseScriptureRefs(text)
    .map(r => `${r.bookName} ${r.chapter}${r.startVerse ? `:${r.startVerse}${r.endVerse !== r.startVerse ? `-${r.endVerse}` : ''}` : ''}`);

test('a comma-separated list repeats the book across chapter:verse pairs', () => {
    assert.deepEqual(
        coords('Acts 3:15, 3:26, 4:33, 17:31'),
        ['Acts 3:15', 'Acts 3:26', 'Acts 4:33', 'Acts 17:31']
    );
});

test('a bare number after a verse means the same chapter', () => {
    assert.deepEqual(
        coords('Acts 3:15, 26; 4:33; 17:31'),
        ['Acts 3:15', 'Acts 3:26', 'Acts 4:33', 'Acts 17:31']
    );
});

test('chapter context updates as the list advances', () => {
    // The bare 12 must attach to chapter 4 (named just before it), not to
    // chapter 3 from the start of the list.
    assert.deepEqual(coords('Acts 3:15, 4:33, 12'), ['Acts 3:15', 'Acts 4:33', 'Acts 4:12']);
});

test('a bare range continues the current chapter', () => {
    assert.deepEqual(coords('Rom 8:28, 31-32'), ['Romans 8:28', 'Romans 8:31-32']);
});

test('after a chapter-only reference a bare number is another chapter', () => {
    assert.deepEqual(coords('John 1; 3; 5'), ['John 1', 'John 3', 'John 5']);
});

test('a numeric book prefix is not swallowed as a verse', () => {
    // REGRESSION: "; 1 Cor 15:1-58" read the 1 as a verse in chapter 6 and ate
    // the book name behind it, so 1 Cor 15 vanished entirely. This exact string
    // is the shape Biblicana's own AI answers produce.
    assert.deepEqual(
        coords('1 Cor 6:14; 1 Cor 15:1-58; 1 John 3:2'),
        ['1 Corinthians 6:14', '1 Corinthians 15:1-58', '1 John 3:2']
    );
});

test('a following book with a numeric prefix wins over a bare verse reading', () => {
    assert.deepEqual(coords('Acts 3:15, 2 Cor 5:1'), ['Acts 3:15', '2 Corinthians 5:1']);
});

test('a bare 1-3 IS a verse when no book follows it', () => {
    // The guard above must not cost us the ordinary reading.
    assert.deepEqual(coords('Rom 8:28, 2'), ['Romans 8:28', 'Romans 8:2']);
});

test('a year after a reference is not read as a verse', () => {
    // 2020 exceeds any real verse number, which is what the bound is for.
    assert.deepEqual(coords('John 3:16, 2020 was a hard year'), ['John 3:16']);
});

test('ordinary prose after a reference does not continue the list', () => {
    assert.deepEqual(coords('I read John 3:16, and then went home'), ['John 3:16']);
});

test('a full AI-style citation list parses completely', () => {
    assert.deepEqual(
        coords('1 Pet 1:2-3, 1:21, 3:21; 1 Thess 4:14-16; 2 Cor 5:14-15'),
        ['1 Peter 1:2-3', '1 Peter 1:21', '1 Peter 3:21', '1 Thessalonians 4:14-16', '2 Corinthians 5:14-15']
    );
});

test('continuations are deduped like anchored references', () => {
    assert.deepEqual(coords('Acts 3:15, 3:15, 15'), ['Acts 3:15']);
});
