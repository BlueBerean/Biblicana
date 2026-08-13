// Coverage for the verse pager's paging maths and control encoding.
//
// The pager has two views over ONE list: the public post shows a single
// reference per page, the private view groups up to three. Everything is
// addressed by REFERENCE index rather than page number so the arrows and the
// jump menu agree across both — most of these tests pin that.
//
// Reads bible.db for verse lengths, same as the studyHelper tests.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computePageGroups,
    buildPaginatedComponents,
    buildPrivatePageComponents,
    PAGER_MODE_SHARED,
    PAGER_MODE_OWNER,
    PAGER_MODE_PRIVATE,
} from '../src/utils/passiveDetection.js';

const ref = (bookId, bookName, chapter, startVerse, endVerse) =>
    ({ bookId, bookName, chapter, startVerse, endVerse });

const SHORT = [
    ref(43, 'John', 11, 35, 35),      // "Jesus wept."
    ref(44, 'Acts', 3, 15, 15),
    ref(44, 'Acts', 3, 26, 26),
    ref(44, 'Acts', 4, 33, 33),
    ref(45, 'Romans', 8, 28, 28),
];
const HUGE = ref(46, '1 Corinthians', 15, 1, 58);
const OWNER = '625907582296522752';
const ORIGIN = '1494355280039776329';

const rows = components => components.map(c => c.toJSON());
const customIds = row => row.components.map(b => b.custom_id);

// --- grouping --------------------------------------------------------------

test('short references group up to three per page', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');
    assert.deepEqual(groups, [[0, 1, 2], [3, 4]]);
});

test('every reference appears exactly once across the groups', async () => {
    const groups = await computePageGroups([...SHORT, HUGE], 'BSB');
    const flat = groups.flat();
    assert.deepEqual(flat, [...flat].sort((a, b) => a - b), 'groups must stay in order');
    assert.equal(new Set(flat).size, flat.length, 'no reference may be duplicated');
    assert.equal(flat.length, 6, 'no reference may be dropped');
});

test('a reference too long to share a page gets one to itself', async () => {
    // 1 Cor 15:1-58 fills the whole budget, so it cannot sit beside anything.
    const groups = await computePageGroups([SHORT[0], HUGE, SHORT[1]], 'BSB');
    const huge = groups.find(g => g.includes(1));
    assert.deepEqual(huge, [1], `expected 1 Cor 15 alone, got ${JSON.stringify(huge)}`);
});

test('grouping is DETERMINISTIC regardless of where a reader jumps in', async () => {
    // The property the whole design rests on. Grouping greedily from whatever
    // reference someone jumped to would give different boundaries per entry
    // point, so Back then Next could land somewhere new.
    const a = await computePageGroups(SHORT, 'BSB');
    const b = await computePageGroups(SHORT, 'BSB');
    assert.deepEqual(a, b);
});

test('a single reference produces a single group', async () => {
    assert.deepEqual(await computePageGroups([SHORT[0]], 'BSB'), [[0]]);
});

// --- public view -----------------------------------------------------------

test('the public view carries the jump menu and NO arrow row', async () => {
    // container + jump menu + study tools. The arrows were dropped: the menu
    // reaches every reference in one interaction, so a control that can only
    // step by one was chrome. Position lives in the container footer.
    const c = await buildPaginatedComponents(SHORT, 'BSB', 0, { mode: PAGER_MODE_SHARED });
    assert.equal(c.length, 3);
    assert.ok(
        !JSON.stringify(rows(c)).includes('passivepage:'),
        'the public post must carry no page buttons'
    );
    assert.equal(rows(c)[1].components[0].options.length, SHORT.length, 'menu lists every reference');
});

test('the public footer still reports the position the arrows used to show', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', 2, { mode: PAGER_MODE_SHARED });
    assert.match(JSON.stringify(rows(c)[0]), /Reference 3 of 5/);
});

test('owner mode puts the owner id on the menu', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', 1, { mode: PAGER_MODE_OWNER, ownerId: OWNER });
    assert.equal(rows(c)[1].components[0].custom_id, `passiveref:o:${OWNER}`);
});

test('shared mode carries no owner id', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', 1, { mode: PAGER_MODE_SHARED });
    assert.equal(rows(c)[1].components[0].custom_id, 'passiveref:u');
});

test('a lone reference gets no menu at all', async () => {
    // A one-option picker advertises a choice it doesn't have.
    const c = await buildPaginatedComponents([SHORT[0]], 'BSB', 0, { mode: PAGER_MODE_OWNER, ownerId: OWNER });
    assert.equal(c.length, 2, 'container + study tools only');
});

test('an out-of-range index clamps instead of throwing', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', 999, { mode: PAGER_MODE_SHARED });
    const options = rows(c)[1].components[0].options;
    assert.equal(options.findIndex(o => o.default), SHORT.length - 1, 'clamps to the last reference');
});

// --- private view ----------------------------------------------------------

test('the private view renders the group containing the requested reference', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');   // [[0,1,2],[3,4]]
    const c = await buildPrivatePageComponents(SHORT, 'BSB', groups, 4, { originId: ORIGIN });
    // Asking for reference 4 must render its whole page, not reference 4 alone.
    const containers = rows(c).filter(x => x.type === 17);
    assert.equal(containers.length, 2, 'group [3,4] means two cards');
});

test('private controls point back at the ORIGIN message, not the private one', async () => {
    // The Redis key is the public post's id. Without the origin, a second click
    // would look up a key that never existed.
    const groups = await computePageGroups(SHORT, 'BSB');
    const c = await buildPrivatePageComponents(SHORT, 'BSB', groups, 0, { originId: ORIGIN });
    const json = rows(c);
    const pager = json.find(x => x.type === 1 && customIds(x).some(id => id.startsWith('passivepage:')));
    assert.ok(customIds(pager).every(id => id === 'passivepage:noop' || id.endsWith(`:x:${ORIGIN}`)));
    const menu = json.find(x => x.type === 1 && x.components[0]?.custom_id?.startsWith('passiveref:'));
    assert.equal(menu.components[0].custom_id, `passiveref:${PAGER_MODE_PRIVATE}:${ORIGIN}`);
});

test('private paging steps by PAGE but addresses by REFERENCE', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');   // [[0,1,2],[3,4]]
    const c = await buildPrivatePageComponents(SHORT, 'BSB', groups, 0, { originId: ORIGIN });
    const pager = rows(c).find(x => x.type === 1 && customIds(x).some(id => id.startsWith('passivepage:')));
    // Next from page 1 must target reference 3 — the FIRST of the next group.
    assert.equal(customIds(pager)[2], `passivepage:3:x:${ORIGIN}`);
});

test('a private page stays inside Discord component limits', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');
    for (let i = 0; i < SHORT.length; i++) {
        const c = await buildPrivatePageComponents(SHORT, 'BSB', groups, i, { originId: ORIGIN, omitted: 3 });
        assert.ok(c.length <= 10, `reference ${i} produced ${c.length} top-level components`);
    }
});

// --- overflow --------------------------------------------------------------

test('omitted references are named on the LAST page, not as an error', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');
    const last = await buildPrivatePageComponents(SHORT, 'BSB', groups, 4, { originId: ORIGIN, omitted: 7 });
    const text = JSON.stringify(rows(last));
    assert.match(text, /7 more references/);
    assert.match(text, /\/bible/);
});

test('earlier pages carry no overflow note', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');
    const first = await buildPrivatePageComponents(SHORT, 'BSB', groups, 0, { originId: ORIGIN, omitted: 7 });
    assert.doesNotMatch(JSON.stringify(rows(first)), /more references/);
});

test('no overflow note when nothing was omitted', async () => {
    const groups = await computePageGroups(SHORT, 'BSB');
    const last = await buildPrivatePageComponents(SHORT, 'BSB', groups, 4, { originId: ORIGIN, omitted: 0 });
    assert.doesNotMatch(JSON.stringify(rows(last)), /couldn't be shown/);
});

test('the public footer names omissions on the FIRST page, not just the last', async () => {
    // The case this exists for: an owner opens on reference 1 and never walks
    // to the end, so an end-of-list note is invisible to the person most likely
    // to care that their 30 references became 25.
    const first = await buildPaginatedComponents(SHORT, 'BSB', 0, { mode: PAGER_MODE_SHARED, omitted: 5 });
    assert.match(JSON.stringify(rows(first)[0]), /Reference 1 of 5 . 5 more not shown/);
});

test('the public footer omits the count when nothing was dropped', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', 0, { mode: PAGER_MODE_SHARED });
    assert.doesNotMatch(JSON.stringify(rows(c)[0]), /not shown/);
});

test('the public last page also says what to do about the omissions', async () => {
    const c = await buildPaginatedComponents(SHORT, 'BSB', SHORT.length - 1, { mode: PAGER_MODE_SHARED, omitted: 2 });
    const json = JSON.stringify(rows(c));
    assert.match(json, /2 more not shown/, 'footer count on every page');
    assert.match(json, /2 more references/, 'actionable note on the last page');
    assert.match(json, /\/bible/);
});
