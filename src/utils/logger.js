import log from 'loglevel';

// Level: LOGLEVEL if set, else info in production and debug everywhere else.
//
// LOGLEVEL exists because NODE_ENV now carries two jobs. It must be
// "production" on the droplet for Sentry's environment and the heartbeat, but
// some diagnostic trails live only at debug — the AI role-gate suppression
// line, passive-config read failures — and would otherwise vanish from prod.
// LOGLEVEL=debug brings them back without lying to Sentry about where it is.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

export function resolveLevel(env = process.env) {
  const requested = env.LOGLEVEL?.trim().toLowerCase();
  if (requested && LEVELS.includes(requested)) return { level: requested };
  const fallback = env.NODE_ENV === 'production' ? 'info' : 'debug';
  // A typo here would otherwise silently leave prod at the wrong level.
  return requested
    ? { level: fallback, warning: `[Logger] LOGLEVEL="${env.LOGLEVEL}" is not one of ${LEVELS.join(', ')}; using ${fallback}.` }
    : { level: fallback };
}

const { level, warning } = resolveLevel();
log.setLevel(level);
if (warning) log.warn(warning);

export default log;
