// Pure-function coverage for the Father classification helpers in
// src/utils/studyHelper.js.
//
// The extrabiblical_data collection is 2,000 years of Christian commentary
// under a patristic label: 285 genuinely patristic authors alongside 49
// medieval, Reformation-era and modern writers (C.S. Lewis, Tolkien, and at
// least one living author). Getting this classification wrong means the bot
// tells someone the early church said something C.S. Lewis wrote in 1963.
//
// NOTE: importing studyHelper.js opens the SQLite files as a side effect of
// module load. That is fine here — the files are present in dev — but it is
// why these tests only exercise the pure exports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { classifyFather, fatherEraBadge, normalizeFatherName } from '../src/utils/studyHelper.js';

// --- normalizeFatherName ---------------------------------------------------
// The DB stores "CS Lewis" with no periods, so a correctly-typed "C.S. Lewis"
// used to match nothing. Both sides of the comparison must normalise the same
// way or the match silently fails.

test('punctuation variants of a name collapse to one key', () => {
    const expected = 'cslewis';
    assert.equal(normalizeFatherName('C.S. Lewis'), expected);
    assert.equal(normalizeFatherName('CS Lewis'), expected);
    assert.equal(normalizeFatherName('c.s.lewis'), expected);
    assert.equal(normalizeFatherName('C S Lewis'), expected);
});

test('hyphens and apostrophes are stripped too', () => {
    assert.equal(normalizeFatherName("Pseudo-Dionysius"), 'pseudodionysius');
    assert.equal(normalizeFatherName("John of the Cross"), 'johnofthecross');
});

test('null and undefined normalise to an empty string, not a crash', () => {
    assert.equal(normalizeFatherName(null), '');
    assert.equal(normalizeFatherName(undefined), '');
});

// --- classifyFather (model-facing) -----------------------------------------

test('patristic authors are classified as Church Fathers', () => {
    assert.equal(classifyFather('430').patristic, true);      // Augustine
    assert.equal(classifyFather('800').patristic, true);      // era boundary, inclusive
});

test('post-800 authors are NOT Church Fathers', () => {
    assert.equal(classifyFather('801').patristic, false);     // just past the boundary
    assert.equal(classifyFather('1274').patristic, false);    // Aquinas
    assert.equal(classifyFather('1963').patristic, false);    // C.S. Lewis
});

test('undated and pseudonymous works count as patristic-adjacent', () => {
    // 9999 is the dataset's marker for undated/pseudonymous works, which are
    // patristic-adjacent rather than modern.
    assert.equal(classifyFather('9999').patristic, true);
    assert.equal(classifyFather(null).patristic, true);
    assert.equal(classifyFather('not a year').patristic, true);
});

test('non-patristic era strings warn the model explicitly', () => {
    // These strings are injected into the prompt, so the disclaimer has to be
    // in the string itself — the model never sees the boolean.
    assert.match(classifyFather('1963').era, /NOT a Church Father/);
    assert.match(classifyFather('1274').era, /NOT a Church Father/);
    assert.doesNotMatch(classifyFather('430').era, /NOT a Church Father/);
});

test('default_year is parsed from TEXT, not assumed numeric', () => {
    // The column is TEXT in the DB; a string must classify identically.
    assert.deepEqual(classifyFather('430'), classifyFather(430));
});

// --- fatherEraBadge (user-facing) ------------------------------------------

test('genuine Fathers get no badge', () => {
    assert.equal(fatherEraBadge('430'), null);
    assert.equal(fatherEraBadge('9999'), null);
    assert.equal(fatherEraBadge(null), null);
});

test('later writers get a short, non-scolding badge', () => {
    // classifyFather's era strings shout "NOT a Church Father" because they
    // instruct a model. In the UI that reads as scolding, so the badge is
    // deliberately calmer while still being accurate.
    assert.equal(fatherEraBadge('1295'), 'Medieval · c. 1295');
    assert.equal(fatherEraBadge('1637'), 'Reformation era · c. 1637');
    assert.equal(fatherEraBadge('1963'), 'Modern · c. 1963');
    assert.doesNotMatch(fatherEraBadge('1963'), /NOT/);
});

test('badge and classification never disagree', () => {
    // A badge means "not patristic"; no badge means "patristic". If these ever
    // drift apart, /fathers and the AI path would tell users different things
    // about the same author.
    for (const year of ['430', '800', '801', '1274', '1500', '1963', '9999', null, 'junk']) {
        const { patristic } = classifyFather(year);
        const badge = fatherEraBadge(year);
        assert.equal(patristic, badge === null, `disagreement for year=${JSON.stringify(year)}`);
    }
});
