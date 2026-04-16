// Shared embed chrome. Accent color and footer text are configured via the
// EMBEDCOLOR and EMBEDFOOTERTEXT env vars so prod and dev can look distinct.

const DEFAULT_ACCENT = 0x083459;
const DEFAULT_FOOTER = 'Biblicana';

export function accentColor() {
    return process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : DEFAULT_ACCENT;
}

// Build a small-text footer line. `suffix` is shown after a separator when
// provided. Result already includes the `-#` markdown that renders as footer
// text in a V2 TextDisplay component.
export function footerLine(suffix = '') {
    const base = process.env.EMBEDFOOTERTEXT || DEFAULT_FOOTER;
    return suffix ? `-# ${base} | ${suffix}` : `-# ${base}`;
}
