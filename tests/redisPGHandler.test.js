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

test('setValue overwrites the tombstone — no stale null after a write', async () => {
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
