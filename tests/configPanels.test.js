// Structural invariant shared by every /config panel.
//
// Each select handler saves ONE setting and then re-renders the WHOLE panel.
// So it must source every setting the panel displays — the one it just changed
// plus all the ones it did not. Miss one and the database still holds the right
// value while the panel renders it as unset, which reads to an admin as "my
// setting was just cleared". The data is fine; only the render lies, which is
// why review keeps missing it.
//
// Broken three times by hand before this test existed:
//   - configAi.js and config.js dropped readAiRequiredRoles
//   - configAiRoles.js rendered the required picker blank
//   - configPassiveMode.js would have blanked the new channel allowlist
//
// This asserts on SOURCE TEXT rather than behaviour on purpose. Driving these
// handlers for real needs a live Discord interaction plus a database; the
// failure being guarded against is a missing read, which is visible statically
// and cheap to check on every run.
//
// NOTE: test names stay ASCII — prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SELECTS_DIR = new URL('../src/components/selects/', import.meta.url);

// Each panel: which handlers belong to it, the builder that marks a handler as
// re-rendering it, and every setting that panel displays.
const PANELS = [
    {
        name: 'config ai',
        filePattern: /^configAi.*\.js$/,
        builder: 'buildAiConfigView',
        minHandlers: 4,
        settings: [
            ['enabled', /readAiEnabled|saveAiEnabled/],
            ['memory scope', /readAiMemoryScope|saveAiMemoryScope/],
            ['channels', /readAiChannels|saveAiChannels/],
            ['denied roles', /readAiDeniedRoles|saveAiDeniedRoles/],
            ['required roles', /readAiRequiredRoles|saveAiRequiredRoles/],
        ],
    },
    {
        name: 'config passive',
        filePattern: /^configPassive.*\.js$/,
        builder: 'buildConfigView',
        minHandlers: 5,
        settings: [
            ['passive mode', /readPassiveMode|savePassiveMode/],
            ['channels', /readPassiveChannels|savePassiveChannels/],
            ['autopost layout', /readPassivePaginate|savePassivePaginate/],
            ['pager privacy', /readPassivePagerPrivate|savePassivePagerPrivate/],
            ['verse detail', /readPassiveDetail|savePassiveDetail/],
        ],
    },
];

for (const panel of PANELS) {
    test(`every ${panel.name} handler sources all settings the panel shows`, async () => {
        const files = (await readdir(SELECTS_DIR)).filter(f => panel.filePattern.test(f));

        // Guard the guard: a bad pattern matching nothing would pass silently.
        assert.ok(
            files.length >= panel.minHandlers,
            `expected at least ${panel.minHandlers} handlers for ${panel.name}, found ${files.length}`
        );

        let checked = 0;
        for (const file of files) {
            const src = await readFile(new URL(file, SELECTS_DIR), 'utf8');
            // Only handlers that re-render the shared panel are subject to this.
            if (!src.includes(panel.builder)) continue;
            checked++;
            for (const [label, pattern] of panel.settings) {
                assert.match(
                    src,
                    pattern,
                    `${file} never reads or writes ${label}, so the panel it renders will show it as unset`
                );
            }
        }

        assert.ok(checked > 0, `no ${panel.name} handler calls ${panel.builder} — did the builder get renamed?`);
    });
}

// The /config command itself renders every panel cold, so it has the same
// obligation as the handlers and none of the "I just saved this one" excuse.
test('the config command sources every setting for every panel it renders', async () => {
    const src = await readFile(new URL('../src/commands/config.js', import.meta.url), 'utf8');
    for (const panel of PANELS) {
        assert.ok(src.includes(panel.builder), `config.js no longer calls ${panel.builder}`);
        for (const [label, pattern] of panel.settings) {
            assert.match(src, pattern, `config.js renders the ${panel.name} panel without sourcing ${label}`);
        }
    }
});
