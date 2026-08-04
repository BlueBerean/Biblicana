import 'dotenv/config';

// Postgres pool configuration.
//
// The timeout settings below are NOT optional tuning — without them `pg.Pool`
// runs on defaults that include `connectionTimeoutMillis: 0`, meaning a caller
// waiting for a free connection waits FOREVER. When Neon stalls (autosuspend
// wake, `Authentication timed out`, `Connection terminated unexpectedly` — all
// observed in prod logs), every checked-out connection hangs, the pool drains,
// and every subsequent query queues behind it indefinitely. A transient blip
// becomes permanent exhaustion until the process restarts.
//
// Values are deliberately generous rather than tight. The 3-second Discord ack
// window is protected by deferring FIRST in command handlers, not by these
// timeouts — once a handler has deferred, DB latency no longer races the
// deadline. So these exist to bound damage, not to meet a deadline, and they
// are sized to survive a Neon cold start (which can exceed 2s) without
// spurious failures.
const postgresConfig = {
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: {
        rejectUnauthorized: true
    },
    port: 5432,

    // Pool sizing. Neon's free/Launch tiers cap concurrent connections well
    // above this; 10 is about contention between the daily-verse batch job and
    // interactive commands, not about the server's limit.
    max: 10,

    // Wait at most 5s to acquire a connection, then throw. Generous enough for
    // a Neon autosuspend wake; finite, which is the entire point.
    connectionTimeoutMillis: 5000,

    // Server-side cap. This is the one that actually RELEASES the slot — a
    // client-side give-up alone leaves the backend still chewing on the query
    // and holding its connection, so `query_timeout` without `statement_timeout`
    // does not prevent pool exhaustion.
    statement_timeout: 8000,

    // Client-side cap, as a backstop for cases where the server never responds
    // at all (TLS half-open, dropped socket) and `statement_timeout` can't fire.
    query_timeout: 8000,

    // Close idle connections after 30s. Neon drops idle TCP aggressively; a
    // connection we think is alive but the server has already reaped shows up
    // as `Connection terminated unexpectedly` on next use.
    idleTimeoutMillis: 30000,

    // TCP keepalive, for the same reason — keeps NAT/proxy state warm so idle
    // connections aren't silently blackholed.
    keepAlive: true,
};

export { postgresConfig };
export default { postgresConfig };
