// PM2 process definition for PROD (the droplet). Local dev uses `pnpm start`.
//
// .cjs because package.json is "type": "module" and PM2 loads this with
// require(). Paths are the post-migration layout (docs/ops/host-migration-2026-09.md):
// the repo at /srv/biblicana, owned by the `biblicana` user, logs in
// /var/log/biblicana so the `opsread` group can read them without root.
//
// Every setting here was previously a flag someone had to remember:
//   --import      Sentry must load before index.js or it hooks nothing, and
//                 the bot runs with Sentry silently off (src/instrument.js).
//   time          PM2 prefixes each log line with a timestamp. The old host's
//                 logs had none, so no one could select a time window.
//   400M          the ceiling the old host ran with; the bot sits ~180 MB.
//   name 'index'  kept from the old host so log names, greps and the ops
//                 knowledge pack (index-out.log) carry over unchanged.

module.exports = {
    apps: [{
        name: 'index',
        cwd: '/srv/biblicana',
        script: 'src/index.js',
        node_args: '--import ./src/instrument.js',
        exec_mode: 'fork',
        instances: 1,              // one gateway session; two would double-answer
        max_memory_restart: '400M',
        time: true,
        out_file: '/var/log/biblicana/index-out.log',
        error_file: '/var/log/biblicana/index-error.log',
        merge_logs: true,
        // .env (loaded by dotenv in instrument.js / index.js) holds everything
        // else, including NODE_ENV=production. Kept out of this file so it
        // stays the one place secrets and environment live.
        kill_timeout: 10000,       // index.js drains Postgres/Redis and flushes Sentry on SIGINT
        restart_delay: 5000,       // don't hammer Discord's gateway in a crash loop
        max_restarts: 20,
    }],
};
