// Coverage for the AI-chat role denylist in src/utils/aiConfig.js.
//
// The need: a server creates a "No AI" role, hands it out, and holders get no
// response when they mention or reply to Biblicana. Getting this wrong is
// bidirectionally bad — too strict silences the bot for a whole guild, too
// loose means the role does nothing and an admin thinks it's applied.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { isAiDeniedForMember, isAiChannelAllowed } from '../src/utils/aiConfig.js';

// A cached GuildMember: roles is a manager with a .cache Collection.
const cachedMember = (roleIds, { admin = false } = {}) => ({
    roles: { cache: new Map(roleIds.map(id => [id, { id }])) },
    permissions: { has: flag => admin && flag === PermissionFlagsBits.ManageGuild },
});

// A raw gateway/interaction member: roles is a plain array of ID strings.
const rawMember = (roleIds, { admin = false } = {}) => ({
    roles: roleIds,
    permissions: { has: flag => admin && flag === PermissionFlagsBits.ManageGuild },
});

const NO_AI = '111111111111111111';
const MUTED = '222222222222222222';
const REGULAR = '999999999999999999';

// --- the core rule ---------------------------------------------------------

test('an empty denylist denies nobody', () => {
    assert.equal(isAiDeniedForMember([], cachedMember([NO_AI])), false);
    assert.equal(isAiDeniedForMember(undefined, cachedMember([NO_AI])), false);
    assert.equal(isAiDeniedForMember(null, cachedMember([NO_AI])), false);
});

test('a member holding a denied role is denied', () => {
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([NO_AI])), true);
});

test('a member holding none of the denied roles is allowed', () => {
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([REGULAR])), false);
});

test('a member with no roles at all is allowed', () => {
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([])), false);
});

test('holding ANY one of several denied roles is enough', () => {
    assert.equal(isAiDeniedForMember([NO_AI, MUTED], cachedMember([REGULAR, MUTED])), true);
});

// --- the Manage Server exemption -------------------------------------------

test('Manage Server exempts a member even when they hold the denied role', () => {
    // Deliberate: the admin who configures the denylist must not be able to
    // lock themselves out by handing themselves the role, and testing the
    // setting shouldn't require removing their own role first.
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([NO_AI], { admin: true })), false);
});

test('the exemption applies to the raw member shape too', () => {
    assert.equal(isAiDeniedForMember([NO_AI], rawMember([NO_AI], { admin: true })), false);
});

// --- member shape handling -------------------------------------------------
// discord.js hands over a GuildMemberRoleManager when the member is cached, but
// raw payloads carry a plain array of role IDs. Reading only .cache would see
// zero roles on the raw shape and silently let a denied member through.

test('roles as a plain array (raw payload) are read correctly', () => {
    assert.equal(isAiDeniedForMember([NO_AI], rawMember([NO_AI])), true);
    assert.equal(isAiDeniedForMember([NO_AI], rawMember([REGULAR])), false);
});

test('role IDs compare by value, so distinct objects with the same id match', () => {
    // Both sides are String()-coerced, so a Map-keyed cache and a plain array
    // holding the same snowflake compare equal.
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([NO_AI])), true);
    assert.equal(isAiDeniedForMember([NO_AI], rawMember([NO_AI])), true);
    assert.equal(isAiDeniedForMember([`${NO_AI}`], rawMember([`${NO_AI}`])), true);
});

test('a snowflake that was ever a Number is already corrupt and will not match', () => {
    // Not a defect in this function — a guard against "fixing" it later.
    // Discord snowflakes are 18-19 digits, past Number.MAX_SAFE_INTEGER
    // (~9e15), so Number('111111111111111111') becomes 111111111111111100 and
    // the final digits are gone to float precision. String() cannot undo that.
    //
    // The rule this encodes: snowflakes stay STRINGS end to end. If a role or
    // guild id is ever coerced to a number anywhere upstream, it is corrupt
    // before it reaches here and no comparison can rescue it.
    assert.notEqual(String(Number(NO_AI)), NO_AI, 'precondition: 18-digit ids lose precision as Numbers');
    assert.equal(isAiDeniedForMember([Number(NO_AI)], rawMember([NO_AI])), false);
});

// --- failure modes ---------------------------------------------------------

test('a missing member FAILS OPEN rather than silencing the guild', () => {
    // A denylist that cannot resolve roles should degrade to "everyone
    // allowed". The worst case is one unintended reply; failing closed would
    // make the bot look broken for every member of the server.
    assert.equal(isAiDeniedForMember([NO_AI], null), false);
    assert.equal(isAiDeniedForMember([NO_AI], undefined), false);
    assert.equal(isAiDeniedForMember([NO_AI], {}), false);
});

test('a member with an unrecognised roles shape fails open', () => {
    assert.equal(isAiDeniedForMember([NO_AI], { roles: 'nonsense' }), false);
    assert.equal(isAiDeniedForMember([NO_AI], { roles: null }), false);
});

test('a member without a permissions object is still evaluated', () => {
    // No permissions field means "not an admin" — it must not throw, and must
    // not accidentally exempt everyone.
    assert.equal(isAiDeniedForMember([NO_AI], { roles: [NO_AI] }), true);
});

// --- interaction with the channel allowlist --------------------------------

test('denylist and channel allowlist are independent gates', () => {
    // Both must pass for the AI to fire. The denylist says WHO, the allowlist
    // says WHERE, and neither substitutes for the other.
    const channel = { id: 'c1', parentId: null };

    assert.equal(isAiChannelAllowed(['c1'], channel), true);
    assert.equal(isAiDeniedForMember([NO_AI], cachedMember([NO_AI])), true);

    // Allowed channel + denied member = no response, because messageCreate
    // requires the channel gate to pass AND the member not to be denied.
    const wouldFire = isAiChannelAllowed(['c1'], channel) && !isAiDeniedForMember([NO_AI], cachedMember([NO_AI]));
    assert.equal(wouldFire, false);
});
