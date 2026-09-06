// Coverage for the negative-cache (tombstone) path in src/database/redisPGHandler.js.
//
// getValue sits on EVERY command path, so a regression here is a regression
// everywhere — which is exactly why the miss-caching change ships on its own.
// Before tombstones, getValue cached only hits: the bot is in 527 guilds while
// `guilddata` holds ~26 rows, so ~501 guilds hit Postgres on every single read
// forever (Redis measured a 2.6% hit rate with zero evictions).
//
// These tests instantiate the handler WITHOUT running its constructor, so no
// real Redis or Postgres connection is ever attempted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

// Silence the expected "could not cache miss" / corrupt-cache warnings.
log.setLevel('error');

import DatabaseHandler from '../src/database/redisPGHandler.js';

// Build a handler with fake Redis + Postgres. Object.create skips the
// constructor, which would otherwise open real connections.
function makeHandler({ initialRows = [] } = {}) {
    const store = new Map();      // fake Redis keyspace
    const sets = [];              // every redis.set call, for TTL assertions
    const queries = [];           // every pg.query call, for round-trip counts
    let rows = initialRows;

    const handler = Object.create(DatabaseHandler.prototype);
    handler.expiry = 21600;
    handler.cacheStats = { hits: 0, misses: 0, negHits: 0 };

    handler.redis = {
        get: async (key) => (store.has(key) ? store.get(key) : null),
        set: async (key, value, ...rest) => {
            store.set(key, value);
            sets.push({ key, value, rest });
            return 'OK';
        },
        del: async (key) => (store.delete(key) ? 1 : 0),
    };

    handler.pg = {
        query: async (sql, params) => {
            queries.push({ sql: String(sql).trim(), params });
            if (/^SELECT/i.test(String(sql).trim())) {
                return { rows, rowCount: rows.length };
            }
            return { rows: [], rowCount: 1 };   // INSERT ... ON CONFLICT
        },
    };

    return {
        handler,
        store,
        sets,
        queries,
        selectCount: () => queries.filter(q => /^SELECT/i.test(q.sql)).length,
        setRows: (next) => { rows = next; },
    };
}

test('cold miss queries Postgres once and returns null', async () => {
    const h = makeHandler({ initialRows: [] });
    const value = await h.handler.getValue('guild:123');

    assert.equal(value, null);
    assert.equal(h.selectCount(), 1, 'should hit Postgres exactly once on a cold miss');
});

test('a miss is cached, so the second read does NOT hit Postgres again', async () => {
    const h = makeHandler({ initialRows: [] });

    await h.handler.getValue('guild:123');
    assert.equal(h.selectCount(), 1);

    await h.handler.getValue('guild:123');
    await h.handler.getValue('guild:123');

    assert.equal(h.selectCount(), 1, 'repeat reads must be served from the negative cache');
    assert.equal(h.handler.cacheStats.negHits, 2, 'both repeats counted as negative-cache hits');
});

test('the tombstone never leaks to the caller as a value', async () => {
    const h = makeHandler({ initialRows: [] });
    await h.handler.getValue('guild:123');

    // Something IS stored under the key...
    assert.ok(h.store.get('guild:123'), 'a tombstone should be written');
    // ...but callers still see null, never the sentinel string.
    assert.equal(await h.handler.getValue('guild:123'), null);
});

test('the tombstone is not valid JSON, so a bypassed check degrades safely', async () => {
    const h = makeHandler({ initialRows: [] });
    await h.handler.getValue('guild:123');

    // Defense in depth: if the sentinel check were ever removed, JSON.parse
    // must throw so the corrupt-cache handler falls through to Postgres,
    // rather than the sentinel being returned as if it were real data.
    assert.throws(() => JSON.parse(h.store.get('guild:123')));
});

test('the tombstone TTL is much shorter than the real-record TTL', async () => {
    const h = makeHandler({ initialRows: [] });
    await h.handler.getValue('guild:123');

    const tombstoneSet = h.sets.at(-1);
    const ttl = tombstoneSet.rest.at(-1);
    assert.equal(typeof ttl, 'number');
    assert.ok(ttl > 0 && ttl < h.handler.expiry,
        `tombstone TTL (${ttl}s) must be positive and well below the record TTL (${h.handler.expiry}s)`);
});

// NOTE: test NAMES must stay ASCII. Node 18.13 (prod's version) has a TAP lexer
// that fails on a non-ASCII character in a test description — "Unexpected
// character: — at line 1, column 0" — and takes the whole FILE down with it,
// reporting 0 passed. Node 18.20 (local dev) parses it fine, so this only
// surfaces on the droplet. Em-dashes are fine everywhere else, including inside
// assertion messages and comments.
test('setValue overwrites the tombstone: no stale null after a write', async () => {
    const h = makeHandler({ initialRows: [] });

    // Guild has no row yet; this caches the absence.
    assert.equal(await h.handler.getValue('guild:123'), null);

    // Guild configures something for the first time.
    await h.handler.setValue('guild:123', { passiveMode: 'react_user' });

    // The very next read must see the new value, NOT a stale tombstone.
    // This is the case the tombstone design has to get right: the sentinel
    // lives at the same key a real value would, so setValue clears it for free.
    const after = await h.handler.getValue('guild:123');
    assert.deepEqual(after, { passiveMode: 'react_user' });
});

test('a real cached value is parsed and skips Postgres', async () => {
    const h = makeHandler({ initialRows: [] });
    h.store.set('guild:123', JSON.stringify({ passiveMode: 'react_biblebot' }));

    const value = await h.handler.getValue('guild:123');

    assert.deepEqual(value, { passiveMode: 'react_biblebot' });
    assert.equal(h.selectCount(), 0, 'a cache hit must not touch Postgres');
    assert.equal(h.handler.cacheStats.hits, 1);
});

test('a Postgres row is returned and cached as a real value', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:123', data: { passiveMode: 'off' } }] });

    assert.deepEqual(await h.handler.getValue('guild:123'), { passiveMode: 'off' });
    assert.equal(h.selectCount(), 1);

    // Second read served from cache, not Postgres.
    assert.deepEqual(await h.handler.getValue('guild:123'), { passiveMode: 'off' });
    assert.equal(h.selectCount(), 1);
});

test('a corrupt cache entry falls through to Postgres instead of throwing', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:123', data: { passiveMode: 'off' } }] });
    h.store.set('guild:123', '{not valid json');

    const value = await h.handler.getValue('guild:123');

    assert.deepEqual(value, { passiveMode: 'off' });
    assert.equal(h.selectCount(), 1, 'corrupt cache must fall through, not throw');
});

// --- daily-verse guild list caching ----------------------------------------
// Not a query-count optimisation: Neon bills for time the endpoint is AWAKE and
// autosuspends after ~5 minutes idle. The scheduler ticks every 5 minutes, so
// even one query per tick resets the idle timer forever — the endpoint ran
// continuously from 2026-06-30 (when the scheduler shipped) to 2026-08-01 with
// no suspend events, having previously suspended several times a day.

test('the enabled-guild list is cached, so repeat ticks do not touch Postgres', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:111', data: { dailyVerse: { enabled: true, hour: 13 } } }] });

    await h.handler.getDailyVerseGuilds();
    assert.equal(h.selectCount(), 1);

    // Five more ticks — the pattern that was keeping Neon awake.
    for (let i = 0; i < 5; i++) await h.handler.getDailyVerseGuilds();

    assert.equal(h.selectCount(), 1, 'subsequent ticks must be served from cache');
});

test('cached results are identical to the uncached ones', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:111', data: { dailyVerse: { enabled: true, hour: 13 } } }] });

    const fresh = await h.handler.getDailyVerseGuilds();
    const cached = await h.handler.getDailyVerseGuilds();

    assert.deepEqual(cached, fresh);
    assert.equal(cached[0].guildId, '111');
});

test('a daily-verse write invalidates the cache, so a toggle lands on the next tick', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:111', data: { dailyVerse: { enabled: true, hour: 13 } } }] });

    await h.handler.getDailyVerseGuilds();
    assert.equal(h.selectCount(), 1);

    // A guild disables daily verse. saveDailyVerseConfig calls this after every
    // write; without it the scheduler would keep posting to a guild that had
    // turned the feature off, for up to the cache TTL.
    await h.handler.invalidateDailyVerseGuilds();
    h.setRows([]);

    const after = await h.handler.getDailyVerseGuilds();
    assert.equal(h.selectCount(), 2, 'invalidation must force a fresh read');
    assert.deepEqual(after, [], 'the disabled guild must disappear immediately');
});

test('the cached list carries a short TTL as a backstop', async () => {
    const h = makeHandler({ initialRows: [] });
    await h.handler.getDailyVerseGuilds();

    const write = h.sets.find(s => s.key.startsWith('dailyverse:'));
    assert.ok(write, 'the guild list should be cached under a dailyverse: key');
    const ttl = write.rest.at(-1);
    assert.equal(typeof ttl, 'number');
    assert.ok(ttl > 0, 'a TTL is required so a missed invalidation self-heals');
});

test('a Redis failure falls back to Postgres rather than dropping posts', async () => {
    const h = makeHandler({ initialRows: [{ id: 'guild:111', data: { dailyVerse: { enabled: true, hour: 13 } } }] });
    h.handler.redis.get = async () => { throw new Error('redis down'); };

    const result = await h.handler.getDailyVerseGuilds();

    assert.equal(result.length, 1, 'a Redis outage must not stop the daily verse');
    assert.equal(h.selectCount(), 1);
});

test('getDailyVerseGuilds strips the guild: key prefix', async () => {
    const h = makeHandler({
        initialRows: [
            { id: 'guild:111', data: { dailyVerse: { enabled: true, hour: 13 } } },
            { id: 'guild:222', data: { dailyVerse: { enabled: true, hour: 0 } } },
        ],
    });

    const result = await h.handler.getDailyVerseGuilds();

    // Callers pass these straight to client.guilds.cache.get(), which would
    // never match if the "guild:" prefix survived.
    assert.deepEqual(result.map(r => r.guildId), ['111', '222']);
    assert.equal(result[0].dailyVerse.hour, 13);
    assert.equal(h.selectCount(), 1, 'one query for all enabled guilds, not one per guild');
});

// --- waking a suspended Neon endpoint --------------------------------------
//
// Neon autosuspends after ~5 minutes idle and the first query afterwards has to
// wake it, which can outlast connectionTimeoutMillis. initialize() already
// retries with backoff, but only at BOOT — a runtime query got one attempt.
//
// For a WRITE that is silent data loss dressed as a polite message: the admin
// is told "could not save" and their setting is simply not what they set it to.
// Seen once against the dev branch on 2026-09-06; 7 times in months of prod
// logs, so this is cheap insurance rather than a hot path.
//
// These tests really do wait out the retry delay, so there are deliberately
// few of them.

function makeFlakyHandler({ failures = 1, error } = {}) {
    const attempts = [];
    let remaining = failures;
    const handler = Object.create(DatabaseHandler.prototype);
    handler.expiry = 21600;
    handler.cacheStats = { hits: 0, misses: 0, negHits: 0 };
    handler.redis = {
        get: async () => null,
        set: async () => 'OK',
        del: async () => 1,
    };
    handler.pg = {
        query: async (sql) => {
            attempts.push(String(sql).trim());
            if (remaining > 0) {
                remaining--;
                throw error ?? Object.assign(new Error('Connection terminated due to connection timeout'), {});
            }
            return /^SELECT/i.test(String(sql).trim())
                ? { rows: [], rowCount: 0 }
                : { rows: [], rowCount: 1 };
        },
    };
    return { handler, attempts };
}

test('a write lost to a cold endpoint is retried and succeeds', async () => {
    const h = makeFlakyHandler({ failures: 1 });
    const ok = await h.handler.setValue('guild:123', { id: 'guild:123', passiveDetail: 'compact' });
    assert.equal(ok, true, 'the retry should carry the write through');
    assert.equal(h.attempts.length, 2, 'exactly one retry, not a loop');
});

test('a real error is NOT retried', async () => {
    // A constraint violation fails identically the second time, so retrying it
    // only adds latency to a guaranteed failure.
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const h = makeFlakyHandler({ failures: 1, error: err });
    await assert.rejects(
        () => h.handler.setValue('guild:123', { id: 'guild:123' }),
        /duplicate key/
    );
    assert.equal(h.attempts.length, 1, 'no retry for a statement-level error');
});

test('the retry gives up rather than looping', async () => {
    // An endpoint that is genuinely down must surface, not retry forever.
    const h = makeFlakyHandler({ failures: 5 });
    await assert.rejects(() => h.handler.setValue('guild:123', { id: 'guild:123' }));
    assert.equal(h.attempts.length, 2, 'one original attempt plus one retry, then stop');
});

test('a connection-class SQLSTATE is treated as transient', async () => {
    // 08006 never carries the word "timeout", so message matching alone would
    // miss it - the class check is what catches this one.
    const err = Object.assign(new Error('connection_failure'), { code: '08006' });
    const h = makeFlakyHandler({ failures: 1, error: err });
    const value = await h.handler.getValue('guild:456');
    assert.equal(value, null, 'the read should complete after the retry');
    assert.equal(h.attempts.length, 2);
});
