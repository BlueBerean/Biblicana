// Coverage for isChannelAllowed in src/utils/channelScope.js.
//
// One rule, two features. It gates where AI chat may respond and, since
// 2026-08-13, where passive scripture detection may scan. Getting it wrong is
// bidirectionally bad: too loose and a "quiet" channel gets scanned anyway,
// too strict and a guild that never restricted anything goes silent.
//
// The single most important case is the EMPTY list. Every guild configured
// before either picker existed has no allowlist stored, so "empty means
// everywhere" is what stops a new feature from switching them all off.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isChannelAllowed } from '../src/utils/channelScope.js';

const channel = (id, parentId = null) => ({ id, parentId });

const GENERAL = '111111111111111111';
const BIBLE_STUDY = '222222222222222222';
const OFF_TOPIC = '333333333333333333';

// --- the default: no allowlist ---------------------------------------------

test('an empty allowlist allows every channel', () => {
    assert.equal(isChannelAllowed([], channel(GENERAL)), true);
    assert.equal(isChannelAllowed(undefined, channel(GENERAL)), true);
    assert.equal(isChannelAllowed(null, channel(GENERAL)), true);
});

test('an empty allowlist allows even a channel we cannot identify', () => {
    // Order matters in the implementation: the empty check comes FIRST, so a
    // guild that never restricted anything cannot lose the feature to an
    // unreadable channel object.
    assert.equal(isChannelAllowed([], null), true);
    assert.equal(isChannelAllowed([], undefined), true);
});

// --- an allowlist that exists ----------------------------------------------

test('a listed channel is allowed and an unlisted one is not', () => {
    const allowed = [BIBLE_STUDY];
    assert.equal(isChannelAllowed(allowed, channel(BIBLE_STUDY)), true);
    assert.equal(isChannelAllowed(allowed, channel(OFF_TOPIC)), false);
});

test('any one of several listed channels is enough', () => {
    assert.equal(isChannelAllowed([GENERAL, BIBLE_STUDY], channel(BIBLE_STUDY)), true);
});

test('an unidentifiable channel is refused once an allowlist exists', () => {
    // Opposite of the empty-list case above, and deliberately so: an admin who
    // restricted the feature to two channels should not have it fire in a
    // channel we cannot even name.
    assert.equal(isChannelAllowed([BIBLE_STUDY], null), false);
    assert.equal(isChannelAllowed([BIBLE_STUDY], undefined), false);
});

// --- threads ---------------------------------------------------------------

test('a thread inherits its parent channel allowance', () => {
    // The reason parentId is consulted at all: threads are created constantly
    // and an admin cannot pre-list one that does not exist yet.
    const thread = channel('999999999999999999', BIBLE_STUDY);
    assert.equal(isChannelAllowed([BIBLE_STUDY], thread), true);
});

test('a thread under an unlisted parent is still refused', () => {
    const thread = channel('999999999999999999', OFF_TOPIC);
    assert.equal(isChannelAllowed([BIBLE_STUDY], thread), false);
});

test('a listed thread is allowed even when its parent is not listed', () => {
    // Listing the thread itself is unusual but valid — Discord will hand back
    // a thread id if an admin somehow selects one.
    const thread = channel(BIBLE_STUDY, OFF_TOPIC);
    assert.equal(isChannelAllowed([BIBLE_STUDY], thread), true);
});

test('a null parentId does not accidentally match anything', () => {
    // A top-level channel has parentId null. If null were ever put in an
    // allowlist, the parent branch must not treat that as a match.
    const topLevel = channel(OFF_TOPIC, null);
    assert.equal(isChannelAllowed([BIBLE_STUDY], topLevel), false);
});

// --- the two features are independent --------------------------------------

test('AI chat and passive detection allowlists do not interact', () => {
    // Same function, two separate stored lists. Restricting one says nothing
    // about the other — this pins that the rule carries no feature-specific
    // state that could leak between them.
    const aiChannels = [BIBLE_STUDY];
    const passiveChannels = [GENERAL];
    const inGeneral = channel(GENERAL);

    assert.equal(isChannelAllowed(aiChannels, inGeneral), false);
    assert.equal(isChannelAllowed(passiveChannels, inGeneral), true);
});
