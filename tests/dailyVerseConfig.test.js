// Coverage for the DST-aware hour labels in src/utils/dailyVerseConfig.js.
//
// The old version was an IIFE evaluated once at module load with standard-time
// hints hardcoded. That was wrong twice: every label was an hour off for the
// ~8 months a year the US is on daylight time, and the array froze at process
// start, so a bot booted in January served winter labels until it restarted.
// Kenneth picked 15:00 UTC expecting 10am and got 11am EDT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { buildDailyHourOptions } from '../src/utils/dailyVerseConfig.js';

// Mid-January and mid-July are unambiguously standard and daylight time
// respectively, well clear of any transition weekend.
const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

const descAt = (options, utcHour) => options.find(o => o.value === String(utcHour)).description;

test('produces all 24 UTC hours', () => {
    const options = buildDailyHourOptions(WINTER);
    assert.equal(options.length, 24);
    assert.equal(options[0].label, '00:00 UTC');
    assert.equal(options[23].label, '23:00 UTC');
});

test('winter labels use standard time', () => {
    const winter = buildDailyHourOptions(WINTER);
    assert.match(descAt(winter, 15), /EST/);
    assert.match(descAt(winter, 15), /PST/);
    assert.doesNotMatch(descAt(winter, 15), /EDT|PDT/);
});

test('summer labels use daylight time', () => {
    const summer = buildDailyHourOptions(SUMMER);
    assert.match(descAt(summer, 15), /EDT/);
    assert.match(descAt(summer, 15), /PDT/);
    assert.doesNotMatch(descAt(summer, 15), /EST|PST/);
});

test('15:00 UTC is 10am Eastern in winter but 11am in summer', () => {
    // The exact case that misled Kenneth: the old hardcoded table always said
    // "10am EST", which is only true for a third of the year.
    assert.match(descAt(buildDailyHourOptions(WINTER), 15), /10am EST/);
    assert.match(descAt(buildDailyHourOptions(SUMMER), 15), /11am EDT/);
});

test('hours that cross midnight locally are marked as a previous day', () => {
    const winter = buildDailyHourOptions(WINTER);
    // 00:00 UTC is 7pm the previous day on the US east coast in winter.
    assert.match(descAt(winter, 0), /7pm EST prev day/);
    assert.match(descAt(winter, 0), /4pm PST prev day/);
});

test('noon and midnight are spelled out rather than shown as 0 or 12', () => {
    const winter = buildDailyHourOptions(WINTER);
    assert.match(descAt(winter, 0), /^midnight UTC/);
    assert.match(descAt(winter, 12), /^noon UTC/);
});

test('descriptions stay within Discord\'s 100-character select-option limit', () => {
    for (const at of [WINTER, SUMMER]) {
        for (const option of buildDailyHourOptions(at)) {
            assert.ok(
                option.description.length <= 100,
                `description too long (${option.description.length}): ${option.description}`
            );
            assert.ok(option.label.length <= 100);
        }
    }
});

test('is a function, not a frozen module-load constant', () => {
    // Two calls with different instants must differ — the regression this
    // whole change exists to prevent is the value being computed once at
    // import and then never again.
    const winter = buildDailyHourOptions(WINTER);
    const summer = buildDailyHourOptions(SUMMER);
    assert.notEqual(descAt(winter, 15), descAt(summer, 15));
});
