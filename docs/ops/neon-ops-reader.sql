-- Neon ops_reader: the read-only role the lionmark-ops reporter uses.
--
-- Run ONCE, by hand, as biblicana_owner, against branch `main` of project
-- `Biblicana` (Neon console > SQL Editor, or psql with the owner URL). Try it
-- on `dev-local` first: same schema, isolated data.
--
-- Design: the role can read AGGREGATE VIEWS and nothing else.
--   - Postgres holds no user-written text (checked 2026-09-25: every JSON
--     field in guilddata and userdata is a setting, an ID or a timestamp;
--     AI chat history lives in Redis on the droplet). But the rows are keyed
--     by Discord user and guild snowflakes, which are personal data, and ops
--     needs counts, not rows. So: no grant on either table, at all.
--   - A view runs with its OWNER's privileges (security_invoker defaults to
--     off), so ops_reader can SELECT from ops.* without holding SELECT on
--     guilddata or userdata. Do not set security_invoker = on — the views
--     would then fail for ops_reader, which is the safe failure, but pointless.
--
-- Cost: every connection wakes a suspended compute (autosuspend = plan default,
-- 5 min). The reporter connects ONCE A DAY and runs all four queries in one
-- sitting. See ops-platform knowledge/biblicana/db.md.
--
-- Revoke: ALTER ROLE ops_reader NOLOGIN;   (or DROP ROLE after REVOKE/DROP below)

BEGIN;

-- 1. The role, created WITHOUT login and without a password (applied this
--    way 2026-09-25): nothing uses it until lionmark-ops exists, and a
--    credential with no consumer is only something to leak. Step 5 turns
--    login on, with a password, when the reporter is ready. It cannot create
--    databases or roles, and it inherits nothing.
CREATE ROLE ops_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

-- 2. Hard limits that hold even if the reporter misbehaves.
--    Read-only by default: any write in any session fails.
ALTER ROLE ops_reader SET default_transaction_read_only = on;
--    A runaway query is killed after 5 s; these views return in milliseconds.
ALTER ROLE ops_reader SET statement_timeout = '5s';
--    Do not let an idle reporter session hold the compute awake.
ALTER ROLE ops_reader SET idle_in_transaction_session_timeout = '10s';

-- 3. Nothing by default. Neon's public schema may grant CREATE to PUBLIC on
--    older projects; make sure ops_reader cannot create objects there, and
--    holds no privilege on the real tables.
REVOKE ALL ON SCHEMA public FROM ops_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ops_reader;

-- 4. The views, in their own schema, owned by biblicana_owner.
CREATE SCHEMA IF NOT EXISTS ops AUTHORIZATION biblicana_owner;

-- One row: how many guilds use each feature. Guilds with no row use the
-- defaults (passive mode 'silent', AI off), so rows < total guild count.
CREATE OR REPLACE VIEW ops.guild_summary AS
SELECT
    count(*)                                                                    AS guild_rows,
    count(*) FILTER (WHERE (data::jsonb->>'aiEnabled')::boolean)                AS ai_enabled,
    count(*) FILTER (WHERE jsonb_array_length(COALESCE(data::jsonb->'aiChannels', '[]')) > 0)
                                                                                AS ai_channel_limited,
    count(*) FILTER (WHERE jsonb_array_length(COALESCE(data::jsonb->'aiRequiredRoles', '[]'))
                         + jsonb_array_length(COALESCE(data::jsonb->'aiDeniedRoles', '[]')) > 0)
                                                                                AS ai_role_gated,
    count(*) FILTER (WHERE (data::jsonb->'dailyVerse'->>'enabled')::boolean)    AS daily_verse_enabled,
    -- Daily-verse guilds whose last post is older than yesterday (UTC). A
    -- handful is normal (a guild that removed the bot keeps its row); a jump
    -- means the scheduler stopped posting.
    count(*) FILTER (WHERE (data::jsonb->'dailyVerse'->>'enabled')::boolean
                       AND (data::jsonb->'dailyVerse'->>'lastPostedDate') < to_char(now() AT TIME ZONE 'UTC' - interval '1 day', 'YYYY-MM-DD'))
                                                                                AS daily_verse_stale
FROM public.guilddata;

-- Passive-detection mode counts, one row per mode.
CREATE OR REPLACE VIEW ops.passive_modes AS
SELECT COALESCE(data::jsonb->>'passiveMode', '(unset)') AS mode, count(*) AS guilds
FROM public.guilddata
GROUP BY 1;

-- One row: users with saved preferences, and AI-terms acceptances.
CREATE OR REPLACE VIEW ops.user_summary AS
SELECT
    count(*)                                                    AS user_rows,
    count(*) FILTER (WHERE data::jsonb ? 'aiTermsAcknowledgedAt') AS ai_terms_acknowledged
FROM public.userdata;

-- Database size, for growth tracking.
CREATE OR REPLACE VIEW ops.db_size AS
SELECT pg_database_size(current_database()) AS bytes,
       pg_size_pretty(pg_database_size(current_database())) AS pretty;

-- USAGE on the schema and SELECT on these four views: the whole grant.
GRANT USAGE ON SCHEMA ops TO ops_reader;
GRANT SELECT ON ops.guild_summary, ops.passive_modes, ops.user_summary, ops.db_size TO ops_reader;

COMMIT;

-- 5. WHEN lionmark-ops is ready (not before): enable login with a fresh
--    password, stored only in the Hermes env (ops-platform docs/security.md).
--    Generate with `openssl rand -base64 32`; paste in the SQL editor, never git:
--
--   ALTER ROLE ops_reader WITH LOGIN PASSWORD '<generated>';
--
-- 6. Verify as ops_reader (connection string with the new password):
--
--   SELECT * FROM ops.guild_summary;                 -- one row
--   SELECT * FROM public.guilddata LIMIT 1;          -- must FAIL: permission denied
--   CREATE TABLE ops.x (i int);                      -- must FAIL: read-only / permission denied
--   SHOW default_transaction_read_only;              -- on
