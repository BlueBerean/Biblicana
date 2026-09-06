// Coverage for stripModelMarkup in src/utils/filter.js.
//
// GPT-5.6-Luna annotates some entities with a structured citation token wrapped
// in invisible delimiters, expecting a client that renders it richly. Discord
// shows an empty box per delimiter. Observed in prod 2026-08-10 in a reply about
// C.S. Lewis:
//
//   ...higher tribunal than him" (?entity?["book","The Great Divorce","cs lewis 1945"]?).
//
// gpt-4o-mini never emitted these, so this arrived with the model swap.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripModelMarkup, trimToLastCompleteSentence } from '../src/utils/filter.js';

// U+E003 stands in for the invisible delimiter. The implementation matches the
// whole private-use RANGE, not one codepoint, so the exact value is arbitrary.
const D = '\ue003';

const hasInvisible = s => /[\ue000-\uf8ff\u200b-\u200f\ufeff]/.test(s);

test('recovers the readable name from a delimited entity token', () => {
    const input = `higher tribunal than him" (${D}entity${D}["book","The Great Divorce","cs lewis 1945"]${D}).`;
    const out = stripModelMarkup(input);

    assert.equal(out, 'higher tribunal than him" (The Great Divorce).');
    assert.ok(!hasInvisible(out), 'no invisible characters may survive');
});

test('keeps the name rather than deleting the whole token', () => {
    // The model put the citation there on purpose; dropping it entirely leaves a
    // dangling "()" and loses a real source attribution.
    assert.match(stripModelMarkup(`${D}entity${D}["book","Mere Christianity","lewis"]${D}`), /Mere Christianity/);
});

test('handles tokens with no delimiters at all', () => {
    assert.equal(
        stripModelMarkup('see entity["book","Mere Christianity","lewis"] for more'),
        'see Mere Christianity for more'
    );
});

test('drops an unrecognised token shape instead of leaking boxes', () => {
    const out = stripModelMarkup(`text ${D}entity${D}[weird]${D} after`);
    assert.equal(out, 'text after');
    assert.ok(!hasInvisible(out));
});

test('strips stray invisible characters on their own', () => {
    assert.equal(stripModelMarkup(`plain${D} text`), 'plain text');
    assert.equal(stripModelMarkup('zero\u200bwidth'), 'zerowidth');
});

test('matches the whole private-use range, not one delimiter', () => {
    // A future model revision could pick a different invisible marker.
    for (const cp of ['\ue000', '\ue003', '\uf8ff']) {
        const out = stripModelMarkup(`${cp}entity${cp}["book","Narnia","x"]${cp}`);
        assert.equal(out, 'Narnia', `failed for U+${cp.codePointAt(0).toString(16)}`);
    }
});

test('leaves ordinary text completely untouched', () => {
    const clean = 'Lewis wrote in Mere Christianity that omnipotence means power to do all that is intrinsically possible.';
    assert.equal(stripModelMarkup(clean), clean);
});

test('does not mangle legitimate parentheses or punctuation', () => {
    const s = 'He argues (in Book II, ch. 3) that a square circle is not a task.';
    assert.equal(stripModelMarkup(s), s);
});

test('cleans up the empty parens a removal would otherwise leave', () => {
    assert.equal(stripModelMarkup(`quoted (${D}entity${D}[weird]${D}).`), 'quoted.');
});

test('null and undefined return an empty string, not a crash', () => {
    assert.equal(stripModelMarkup(null), '');
    assert.equal(stripModelMarkup(undefined), '');
});

// --- trimToLastCompleteSentence --------------------------------------------
//
// Applied only when OpenAI reports finish_reason 'length', meaning the model
// ran out of output budget mid-word. Observed in prod 2026-08-13: a user asked
// for a long bulleted list of scriptural positions of honor for women, and the
// answer ended on "**Evangel" with nothing to indicate it had been cut.
//
// The governing rule is that this is COSMETIC. It repairs a ragged ending; it
// must never be the reason a user sees less than the model produced.

test('trims a reply cut off mid-word back to the last complete sentence', () => {
    const cut = 'Deborah judged Israel (Judg 4:4-5). Esther acted for her people (Esth 4:14-16). Priscilla helped instruct Apollos (Acts 18:24-26). **Evangel';
    const out = trimToLastCompleteSentence(cut);
    assert.ok(out.endsWith('(Acts 18:24-26).'), `unexpected ending: ${out}`);
    assert.ok(!out.includes('Evangel'), 'the dangling fragment should be gone');
});

test('drops an unpaired bold marker left by an unfinished bullet', () => {
    // Discord would otherwise render everything after the stray ** as bold.
    const out = trimToLastCompleteSentence('**Judge** - Deborah led Israel. **Prophetess');
    assert.equal((out.match(/\*\*/g) ?? []).length % 2, 0, `unbalanced markers in: ${out}`);
});

test('a verse reference is not mistaken for the end of a sentence', () => {
    // The colon-and-digits of "Gal 1:8" and the period in "Judg 4:4-5" sit
    // inside the sentence; only a period followed by whitespace ends one.
    const s = 'Paul warns in Gal 1:8 that even an angel preaching another gospel is accursed, and Judg 4:4-5 shows Deborah judging Israel under her palm';
    assert.equal(trimToLastCompleteSentence(s), s);
});

test('a closing quote or bracket after the period is kept', () => {
    const s = 'She served the church at Cenchreae (Rom 16:1-2). Then the fragm';
    assert.ok(trimToLastCompleteSentence(s).endsWith('(Rom 16:1-2).'));
});

test('text that is already complete passes through unchanged', () => {
    const s = 'Deborah judged Israel and led with prophetic authority (Judg 4:4-5).';
    assert.equal(trimToLastCompleteSentence(s), s);
});

test('REFUSES to trim when it would cut away too much', () => {
    // One short sentence followed by a long unfinished one. Trimming here would
    // strip most of the answer to fix its ending, which is a worse trade than
    // showing the ragged edge. The 60% floor is the guard.
    const s = 'Sure. Here is the long and detailed explanation you asked for, which runs on at considerable length before it is unceremoniously cut off partway thro';
    assert.equal(trimToLastCompleteSentence(s), s);
});

test('text with no sentence boundary at all is returned as-is', () => {
    const s = 'a fragment with no terminal punctuation anywhere in it';
    assert.equal(trimToLastCompleteSentence(s), s);
});

test('handles null, undefined and empty input without crashing', () => {
    assert.equal(trimToLastCompleteSentence(null), '');
    assert.equal(trimToLastCompleteSentence(undefined), '');
    assert.equal(trimToLastCompleteSentence(''), '');
    assert.equal(trimToLastCompleteSentence('   '), '');
});

test('a question or exclamation ends a sentence too', () => {
    const out = trimToLastCompleteSentence('What is drawing you to this? Want to go deep');
    assert.equal(out, 'What is drawing you to this?');
});
