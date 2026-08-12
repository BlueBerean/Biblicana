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

import { stripModelMarkup } from '../src/utils/filter.js';

// U+E003 stands in for the invisible delimiter. The implementation matches the
// whole private-use RANGE, not one codepoint, so the exact value is arbitrary.
const D = '';

const hasInvisible = s => /[-​-‏﻿]/.test(s);

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
    assert.equal(stripModelMarkup('zero​width'), 'zerowidth');
});

test('matches the whole private-use range, not one delimiter', () => {
    // A future model revision could pick a different invisible marker.
    for (const cp of ['', '', '']) {
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
