import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { parseScriptureRefs, resolveSingleChapterRef } from '../src/utils/scriptureRefs.js';

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

// --- the Isaiah / 1 Samuel collision ---------------------------------------
//
// The optional prefix group is greedy, so a book whose NAME starts with I gets
// split: "Isa 53:3" matched as prefix "I" + word "sa", and "I Sa" is a real
// abbreviation for 1 Samuel. Isaiah silently became 1 Samuel, and the full
// "Isaiah 53" ("I" + "saiah") resolved to nothing and was dropped entirely.
//
// Found in prod 2026-08-13: an AI answer about the Suffering Servant cited
// Isa 53:3-12 and the verse pager rendered "1 Samuel 53:3-12", a chapter that
// does not exist. Isaiah is one of the most-cited books in the bot.
//
// The rule: a prefix written AGAINST the book word gets the joined reading
// first; a prefix separated by a space only ever gets the spaced reading,
// because joining across a space the author typed would invent a name.

test('Isa resolves to Isaiah, not 1 Samuel', () => {
    assert.deepEqual(coords('Isa 53:3-12'), ['Isaiah 53:3-12']);
});

test('the full spelling Isaiah parses at all', () => {
    // Previously returned NOTHING: "I" + "saiah" resolved to no book, and the
    // rewind never recovered the whole word.
    assert.deepEqual(coords('Isaiah 53:3'), ['Isaiah 53:3']);
    assert.deepEqual(coords('Isaiah 53'), ['Isaiah 53']);
});

test('an abbreviated Isaiah with a trailing period still works', () => {
    assert.deepEqual(coords('Isa. 40:31'), ['Isaiah 40:31']);
});

test('a SPACED Roman numeral still means the numbered book', () => {
    // The other side of the fix: "I Sa" separated by a space is 1 Samuel and
    // must not be joined into "ISa".
    assert.deepEqual(coords('I Sa 3:1'), ['1 Samuel 3:1']);
    assert.deepEqual(coords('I John 1:9'), ['1 John 1:9']);
    assert.deepEqual(coords('II Cor 5:17'), ['2 Corinthians 5:17']);
});

test('compact numeric prefixes are unaffected', () => {
    assert.deepEqual(coords('1John 1:9'), ['1 John 1:9']);
    assert.deepEqual(coords('1 John 1:9'), ['1 John 1:9']);
    assert.deepEqual(coords('1 Sam 16:7'), ['1 Samuel 16:7']);
    // This case is about the PREFIX resolving to book 64, which "3 John 1:4"
    // still shows. The chapter it used to expect was incidental, and wrong:
    // 3 John has one chapter, and "3 John 4" is how its verse 4 is cited.
    // See the single-chapter section below.
    assert.deepEqual(coords('3 John 4'), ['3 John 1:4']);
});

test('the prod answer that surfaced this parses correctly end to end', () => {
    const answer = 'Isaiah 53 is the clearest parallel: the Servant is rejected and vindicated'
        + ' (Isa 53:3-12). Jesus fulfills this (Matt 27:12-14; Acts 8:32-35; 1 Pet 2:24-25).'
        + ' Isaiah also foretells a Galilean ministry (Isa 9:1-2; Matt 4:13-16).';
    assert.deepEqual(coords(answer), [
        'Isaiah 53',
        'Isaiah 53:3-12',
        'Matthew 27:12-14',
        'Acts 8:32-35',
        '1 Peter 2:24-25',
        'Isaiah 9:1-2',
        'Matthew 4:13-16',
    ]);
});

// --- single-chapter books --------------------------------------------------
//
// "Jude 5" is how Jude 1:5 is actually cited. Read literally it asks for
// chapter 5 of a one-chapter book, which resolved to nothing at all: passive
// detection posted no card, and the AI's reference tools replied "that's a
// chapter, not a verse - try Jude 5:1", which cannot work either.

test('a bare number in a one-chapter book is a verse, not a chapter', () => {
    const r = one('Jude 5');
    assert.equal(r.bookId, 65);
    assert.equal(r.bookName, 'Jude');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
    assert.equal(r.endVerse, 5);
});

test('every single-chapter book gets the same treatment', () => {
    assert.deepEqual(
        coords('Obadiah 3, Philemon 6, 2 John 4, 3 John 2, Jude 5'),
        ['Obadiah 1:3', 'Philemon 1:6', '2 John 1:4', '3 John 1:2', 'Jude 1:5']
    );
});

test('an explicit chapter:verse in a one-chapter book is left alone', () => {
    const r = one('Jude 1:5');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
});

test('a bare 1 stays a chapter reference', () => {
    // Ambiguous by nature, and the chapter IS the whole book - the more useful
    // of the two readings. "Jude 1:1" still names the verse.
    const r = one('Jude 1');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, null);
});

test('a bare range in a one-chapter book is a verse range', () => {
    // Without this, "Jude 5-7" would silently narrow to a single verse.
    const r = one('Jude 5-7');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
    assert.equal(r.endVerse, 7);
    assert.equal(r.raw, 'Jude 5-7');
});

test('a number past the end of a one-chapter book is not a reference', () => {
    // Jude has 25 verses, so "Jude 40" is neither a chapter nor a verse.
    // Without the bound, "I have read Philemon 30 times" becomes a citation.
    assert.deepEqual(parseScriptureRefs('Jude 40'), []);
    assert.deepEqual(parseScriptureRefs('I have read Philemon 30 times'), []);
});

test('a continuation list carries verses in a one-chapter book', () => {
    assert.deepEqual(coords('Jude 5, 7'), ['Jude 1:5', 'Jude 1:7']);
});

test('a chapter-anchored continuation still reads as verses', () => {
    // "Obadiah 1, 3" cannot mean chapter 3 - the book has no chapter 3.
    assert.deepEqual(coords('Obadiah 1, 3'), ['Obadiah 1', 'Obadiah 1:3']);
});

test('multi-chapter books are unaffected by the remap', () => {
    assert.deepEqual(
        coords('Habakkuk 3 and Titus 2 and John 3:16'),
        ['Habakkuk 3', 'Titus 2', 'John 3:16']
    );
});

test('a one-chapter book still ends a continuation at a new book', () => {
    assert.deepEqual(coords('Jude 5; 1 Cor 15:1'), ['Jude 1:5', '1 Corinthians 15:1']);
});

// --- slash command options -------------------------------------------------
//
// Slash commands never build a reference string - they read `chapter` and
// `verse` as separate typed options and query directly - so parseScriptureRefs
// cannot help them. "/bible book:Jude chapter:5" was broken the same way
// "Jude 5" was, in ten commands.

const JUDE = 65, JOHN = 43;

test('a slash chapter above 1 with no verse is the verse', () => {
    const r = resolveSingleChapterRef(JUDE, 5);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
    assert.equal(r.endVerse, 5);
    assert.equal(r.remapped, true);
});

test('a slash chapter arrives as a string from getString and still remaps', () => {
    // bible, commentary, interlinear, parallel, crossref, originaltext, audio
    // and lxx all read chapter with getString, not getNumber.
    const r = resolveSingleChapterRef(JUDE, '5');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
});

test('an impossible chapter is corrected even when a verse was given', () => {
    // "chapter:5 verse:2" cannot mean chapter 5 - the book has one chapter -
    // so the verse the user typed is kept and the chapter is corrected.
    const r = resolveSingleChapterRef(JUDE, 5, 2);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 2);
    assert.equal(r.remapped, true);
});

test('a verse range survives the chapter correction', () => {
    const r = resolveSingleChapterRef(JUDE, 5, 5, 7);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
    assert.equal(r.endVerse, 7);
});

test('a chapter past the last verse falls back to the chapter itself', () => {
    // Jude has 25 verses, so "chapter:40" is a mistake either way. Showing the
    // book the user named beats showing nothing.
    const r = resolveSingleChapterRef(JUDE, 40);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, null);
});

test('chapter 1 needs no correction', () => {
    const r = resolveSingleChapterRef(JUDE, 1, 5);
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 5);
    assert.equal(r.remapped, false);
});

test('multi-chapter books pass through untouched', () => {
    const r = resolveSingleChapterRef(JOHN, 3, 16);
    assert.equal(r.chapter, 3);
    assert.equal(r.startVerse, 16);
    assert.equal(r.remapped, false);
});

test('a missing book or chapter is left alone', () => {
    // randomverse calls this with no book filter at all.
    const r = resolveSingleChapterRef(null, null);
    assert.equal(r.chapter, null);
    assert.equal(r.remapped, false);
});

test('a range makes a bare 1 a verse in a one-chapter book', () => {
    // REGRESSION: "Obadiah 1-3" showed the WHOLE BOOK. The bare 1 kept its
    // chapter reading, which meant the "-3" was never looked at - so a request
    // for three verses returned twenty-one. A range cannot be a chapter range
    // in a book with one chapter.
    const r = one('Obadiah 1-3');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, 1);
    assert.equal(r.endVerse, 3);
});

test('every single-chapter book reads a leading-1 range as verses', () => {
    assert.deepEqual(
        coords('Obadiah 1-3, Philemon 1-6, 2 John 1-4, 3 John 1-2, Jude 1-3'),
        ['Obadiah 1:1-3', 'Philemon 1:1-6', '2 John 1:1-4', '3 John 1:1-2', 'Jude 1:1-3']
    );
});

test('a bare 1 with NO range is still the whole chapter', () => {
    // The carve-out this fix had to preserve: "Jude 1" is genuinely ambiguous
    // and the chapter is the whole book, which is the more useful reading.
    const r = one('Jude 1');
    assert.equal(r.chapter, 1);
    assert.equal(r.startVerse, null);
});

test('a range past the last verse is not a verse range', () => {
    // Obadiah has 21 verses, so "1-30" is not a citation shape at all; it falls
    // back to the chapter rather than inventing verses the book lacks.
    const r = one('Obadiah 1-30');
    assert.equal(r.startVerse, null);
});

test('multi-chapter books still treat a dash as an unsupported chapter range', () => {
    const r = one('John 3-5');
    assert.equal(r.chapter, 3);
    assert.equal(r.startVerse, null, 'John 3-5 must not become John 3:3-5');
});
