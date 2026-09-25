// Structural coverage: every catch block in a command, button, select menu or
// event handler that logs an error must also report it to Sentry — and the
// nested "could not even send the apology" catches must NOT, or each failure
// would be filed twice.
//
// This exists because the gap was systemic, not local: on 2026-09-25, 119
// catch blocks across 55 files logged errors that never reached Sentry. A
// test per command would not stop the 120th; a scan does. It also guards the
// placement rule: reportError goes beside logger.error, so an existing guard
// such as `if (!isExpiredInteractionError(err))` still keeps routine noise
// (expired menus, 50027) out of Sentry.
//
// Rules, per catch block:
//   - outer (not inside another catch) and does not rethrow, and its own body
//     calls logger.error  =>  its own body must call reportError
//   - nested inside another catch  =>  must not call reportError
//   - rethrows  =>  exempt (the error continues to a handler that reports it)
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src/commands', 'src/components/buttons', 'src/components/selects', 'src/events'];

// Brace-matching scan for `catch (x) { ... }`. Naive about braces inside
// strings, which this codebase does not put in catch blocks; the lower bound
// assertion below would catch the scanner going blind.
function catchBlocks(src) {
    const out = [];
    const re = /catch\s*(\(\s*([A-Za-z_$][\w$]*)\s*\))?\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        let i = re.lastIndex, depth = 1;
        while (depth && i < src.length) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
        }
        out.push({ start: m.index, bodyStart: re.lastIndex, bodyEnd: i - 1, v: m[2] || null });
    }
    return out;
}

// The block's own text, with any nested catch bodies blanked out.
function ownBody(src, block, blocks) {
    let body = src.slice(block.bodyStart, block.bodyEnd);
    const nested = blocks.filter(o => o.start > block.bodyStart && o.start < block.bodyEnd);
    for (const n of nested.sort((a, b) => b.start - a.start)) {
        const s = n.start - block.bodyStart, e = n.bodyEnd - block.bodyStart;
        body = body.slice(0, s) + ' '.repeat(e - s) + body.slice(e);
    }
    return body;
}

function scan() {
    const results = [];
    for (const dir of DIRS) {
        for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.js'))) {
            const rel = `${dir}/${f}`;
            const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
            const blocks = catchBlocks(src);
            for (const b of blocks) {
                const nestedInCatch = blocks.some(o => o !== b && b.start > o.bodyStart && b.start < o.bodyEnd);
                const own = ownBody(src, b, blocks);
                results.push({
                    where: `${rel}:${src.slice(0, b.start).split('\n').length}`,
                    nestedInCatch,
                    logsError: /logger\.error\(/.test(own),
                    reports: /\breportError\(/.test(own),
                    rethrows: /\bthrow\b/.test(own),
                });
            }
        }
    }
    return results;
}

const results = scan();

test('the scan actually sees the catch blocks it is meant to police', () => {
    // An empty or tiny result would mean the scanner stopped matching, not
    // that the code is compliant. Measured 2026-09-25: 155 catch blocks, 93
    // policed (outer, logging, not rethrowing), 35 nested, 3 rethrow-exempt.
    // Allow shrinkage from refactors, not a collapse.
    assert.ok(results.length >= 120, `only ${results.length} catch blocks found`);
    const policed = results.filter(r => !r.nestedInCatch && !r.rethrows && r.logsError);
    assert.ok(policed.length >= 70, `only ${policed.length} error-logging catches found`);
});

test('every catch that logs an error also reports it', () => {
    const missing = results
        .filter(r => !r.nestedInCatch && !r.rethrows && r.logsError && !r.reports)
        .map(r => r.where);
    assert.deepEqual(missing, [],
        `these catch blocks log an error but never call reportError:\n  ${missing.join('\n  ')}`);
});

test('no nested reply-failure catch reports a second time', () => {
    // catch (error) { ...apology... catch (replyError) { logger.error } } -
    // the outer catch already reported the root cause.
    const doubled = results.filter(r => r.nestedInCatch && r.reports).map(r => r.where);
    assert.deepEqual(doubled, [], `nested catches that would double-report:\n  ${doubled.join('\n  ')}`);
});

test('every file that calls reportError imports it', () => {
    const bad = [];
    for (const dir of DIRS) {
        for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
            if (/\breportError\(/.test(src) &&
                !/import\s*\{[^}]*\breportError\b[^}]*\}\s*from\s*'[^']*errorReporting\.js'/.test(src)) {
                bad.push(`${dir}/${f}`);
            }
        }
    }
    assert.deepEqual(bad, [], `calls reportError without importing it: ${bad.join(', ')}`);
});

test('the dispatcher wraps every interaction in a reporting scope', () => {
    // The guild tag on reports from inside commands depends on this.
    const src = fs.readFileSync(path.join(ROOT, 'src/events/interactionCreate.js'), 'utf8');
    for (const area of ['command', 'button', 'select']) {
        assert.match(src, new RegExp(`withReportingScope\\(\\s*\\{\\s*area:\\s*'${area}'`),
            `interactionCreate must wrap ${area} dispatch in withReportingScope`);
    }
});
