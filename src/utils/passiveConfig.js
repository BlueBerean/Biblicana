import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
} from 'discord.js';
import { PASSIVE_MODES } from '../database/schemas/guild.js';
import { PASSIVE_MODE_OPTIONS } from './welcomeCard.js';
import { accentColor, footerLine } from './theme.js';
import logger from './logger.js';

/**
 * Persist the chosen passive mode for a guild. Returns true on success,
 * false on failure (caller decides how to surface the error).
 *
 * Full-replacement semantics via setGuildValue: merges the new mode on top
 * of whatever the guild record already has, or creates a fresh record if
 * one doesn't exist yet. Avoids the fillProperties-throws path since
 * existing older records (pre-passiveMode schema) don't have the key.
 */
export async function savePassiveMode(database, guildId, mode) {
    if (!PASSIVE_MODES.includes(mode)) {
        throw new Error(`Invalid passive mode: ${mode}`);
    }
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, passiveMode: mode };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[PassiveConfig] Failed to save mode=${mode} for guild=${guildId}: ${err.message}`);
        return false;
    }
}

/**
 * Read the current passive mode for a guild. Returns 'silent' if no record
 * exists — matches the default posture for existing (pre-feature) servers,
 * and ensures the select menu renders without a null default.
 */
export async function readPassiveMode(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (g?.passiveMode && PASSIVE_MODES.includes(g.passiveMode)) return g.passiveMode;
    } catch (err) {
        logger.debug(`[PassiveConfig] Read failed for guild=${guildId}: ${err.message}`);
    }
    return 'silent';
}

// Discord's ChannelSelectMenu caps at 25 selections, matching AI_CHANNELS_MAX.
export const PASSIVE_CHANNELS_MAX = 25;

/**
 * Persist the passive-detection channel allowlist. An EMPTY array is a valid,
 * meaningful value — it clears the restriction back to "scan everywhere".
 */
export async function savePassiveChannels(database, guildId, channelIds) {
    try {
        const clean = [...new Set((channelIds ?? []).map(String))].slice(0, PASSIVE_CHANNELS_MAX);
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, passiveChannels: clean };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[PassiveConfig] Channels save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

/**
 * Read the passive-detection channel allowlist. Returns [] — meaning "every
 * channel" — for guilds that have never set one, which is every guild
 * configured before this feature existed.
 */
export async function readPassiveChannels(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (Array.isArray(g?.passiveChannels)) return g.passiveChannels.map(String);
    } catch (err) {
        logger.debug(`[PassiveConfig] Channels read failed for guild=${guildId}: ${err.message}`);
    }
    return [];
}

// Autopost layout choice. Modelled as a two-option select rather than a
// button toggle to match the mode picker directly above it.
export const PASSIVE_STYLE_OPTIONS = [
    {
        value: 'cards',
        label: 'Separate cards (default)',
        description: 'Up to 3 verses shown at once, the rest summarised.',
    },
    {
        value: 'paginated',
        label: 'One card with page buttons',
        description: 'Every verse, browsable with prev/next. No 3-verse cap.',
    },
];

// Who the page buttons move. Only meaningful when the paginated layout is on.
export const PASSIVE_PAGER_OPTIONS = [
    {
        value: 'private',
        label: 'Owner paging (default)',
        description: 'Poster drives the post; everyone else browses privately.',
    },
    {
        value: 'shared',
        label: 'Shared paging',
        description: 'Anyone can move the post for the whole channel.',
    },
];

// How much of a passage an auto-post card shows before it stops.
//
// Named for what an admin can actually observe, not for a character budget.
// "Truncation on/off" was the obvious framing and is the wrong one: Discord
// caps a V2 component tree at 4000 characters and half of all chapters exceed
// even 3000, so nothing here can ever mean "never cut" — a setting promising
// that would be lying. Both levels cut eventually; the Read full button is what
// makes that acceptable.
export const PASSIVE_DETAIL_OPTIONS = [
    {
        value: 'full',
        label: 'Full (default)',
        description: 'Long passages fill the card. Read full opens the rest.',
    },
    {
        value: 'compact',
        label: 'Compact',
        description: 'Shorter excerpts, less scroll in a busy channel.',
    },
];

export async function savePassiveDetail(database, guildId, detail) {
    try {
        const value = detail === 'compact' ? 'compact' : 'full';
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, passiveDetail: value };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[PassiveConfig] Detail save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

/**
 * Read the verse-detail setting. Stored as a STRING rather than a boolean on
 * purpose: a boolean defaulting to TRUE has bitten this file twice, because
 * joi's `.default(true)` never reaches Postgres and `Boolean(undefined)` is
 * false, silently inverting the documented default. Only the exact string
 * 'compact' opts out, so an unset field reads as 'full' with no coercion.
 */
export async function readPassiveDetail(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (g?.passiveDetail === 'compact') return 'compact';
    } catch (err) {
        logger.debug(`[PassiveConfig] Detail read failed for guild=${guildId}: ${err.message}`);
    }
    return 'full';
}

export async function savePassivePagerPrivate(database, guildId, isPrivate) {
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, passivePagerPrivate: Boolean(isPrivate) };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[PassiveConfig] Pager-privacy save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

/**
 * Read the pager-privacy setting. DEFAULTS TRUE, which is why this checks the
 * type rather than coercing: joi's `.default(true)` never reaches Postgres
 * (validateAndSetValue writes the original object, not joi's output), so an
 * unset field arrives as undefined. Boolean(undefined) is false, which would
 * silently invert the documented default for every guild that never touched
 * the setting.
 */
export async function readPassivePagerPrivate(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (typeof g?.passivePagerPrivate === 'boolean') return g.passivePagerPrivate;
    } catch (err) {
        logger.debug(`[PassiveConfig] Pager-privacy read failed for guild=${guildId}: ${err.message}`);
    }
    return true;
}

export async function savePassivePaginate(database, guildId, paginate) {
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, passivePaginate: Boolean(paginate) };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[PassiveConfig] Paginate save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function readPassivePaginate(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        return Boolean(g?.passivePaginate);
    } catch (err) {
        logger.debug(`[PassiveConfig] Paginate read failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

/**
 * Build the compact /config view — title, current-state line, select menus.
 * Deliberately smaller than the welcome card: admins running /config don't
 * need the onboarding demo buttons, just the knobs.
 */
export function buildConfigView({
    currentPassiveMode = 'silent',
    currentChannels = [],
    currentPaginate = false,
    currentPagerPrivate = true,
    currentDetail = 'full',
}) {
    const currentLabel = PASSIVE_MODE_OPTIONS.find(o => o.value === currentPassiveMode)?.label ?? currentPassiveMode;
    const channelsSummary = currentChannels.length === 0
        ? 'All channels'
        : currentChannels.map(id => `<#${id}>`).join(' ');
    const currentStyleValue = currentPaginate ? 'paginated' : 'cards';
    const styleLabel = PASSIVE_STYLE_OPTIONS.find(o => o.value === currentStyleValue).label;
    const currentPagerValue = currentPagerPrivate ? 'private' : 'shared';
    const pagerLabel = PASSIVE_PAGER_OPTIONS.find(o => o.value === currentPagerValue).label;
    const detailValue = currentDetail === 'compact' ? 'compact' : 'full';
    const detailLabel = PASSIVE_DETAIL_OPTIONS.find(o => o.value === detailValue).label;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ Biblicana · Passive Detection'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                `**Current mode:** ${currentLabel}`,
                `**Channels:** ${channelsSummary}`,
                `**Auto-post layout:** ${styleLabel}`,
                `**Verse detail:** ${detailLabel}`,
                ...(currentPaginate ? [`**Paging:** ${pagerLabel}`] : []),
                '',
                'When a user types a scripture reference in chat, what should Biblicana do?',
                '*Changes apply immediately.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Where it scans',
                'By default Biblicana watches for scripture references in **every channel it can read**. Use the channel picker below to **limit the scan to specific channels** — it will ignore every other channel entirely. Clear the selection to go back to all channels.',
                '',
                '*Threads inherit their parent channel. Setting the mode to `silent` turns the scan off everywhere regardless of this list.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Auto-post layout',
                'Only applies to the **auto-post** mode — the react-only modes have nothing to lay out.',
                '',
                '**Separate cards (default)** — each reference gets its own card with study buttons. Capped at **3 references** per message; beyond that a note points to `/bible` for the rest.',
                '',
                '**One card with page buttons** — a single card showing one reference at a time, and **no 3-reference cap**. A message quoting twenty verses becomes twenty pages instead of three cards and a truncation note.',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Who the page buttons move',
                'Only applies to the paginated layout. Every post carries ◀ ▶ and a **Jump to a reference** menu.',
                '',
                '**Owner paging (default)** — whoever posted the references (or asked the AI) drives the public post. Anyone else who taps a control gets **their own private copy**, showing up to 3 references at a time, that only they can see. Nobody pulls the post out from under anyone.',
                '',
                '**Shared paging** — anyone can move the post itself, for the whole channel. Good for a group reading together; the trade-off is that whoever clicks last decides what everyone sees.',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### How much of a passage shows',
                'A single verse always fits — no verse in the Bible is long enough to be cut. This is about **ranges and whole chapters**, where the median chapter is far longer than any card.',
                '',
                '**Full (default)** — a passage uses as much of the card as it can, sized by how many references share the message.',
                '',
                '**Compact** — shorter excerpts, for a busy channel where long quotes push conversation off screen.',
                '',
                '*Either way, when a passage is cut the card gains a **Read full** button that opens the whole thing privately, page by page. Neither setting can show a long chapter in one card — Discord limits the size of a message.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine('Only admins with Manage Server can change this.')
        ));

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:passive')
            .setPlaceholder('Change passive-detection mode')
            .addOptions(PASSIVE_MODE_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentPassiveMode)
            ))
    );

    // minValues 0 so the admin can clear it back to "all channels". Only
    // GuildText/Announcement are offered — threads inherit their parent via
    // isChannelAllowed, so listing them individually is unnecessary.
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('config:passive:channels')
        .setPlaceholder(currentChannels.length
            ? `Scanning ${currentChannels.length} channel${currentChannels.length === 1 ? '' : 's'} — edit or clear`
            : 'Scanning all channels — pick channels to restrict')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(PASSIVE_CHANNELS_MAX);
    if (currentChannels.length > 0) {
        channelSelect.setDefaultChannels(...currentChannels);
    }
    const channelsRow = new ActionRowBuilder().addComponents(channelSelect);

    const styleRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:passive:style')
            .setPlaceholder('Auto-post layout')
            .addOptions(PASSIVE_STYLE_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentStyleValue)
            ))
    );

    const pagerRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:passive:pager')
            .setPlaceholder('Who the page buttons move')
            .addOptions(PASSIVE_PAGER_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentPagerValue)
            ))
    );

    const detailRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:passive:detail')
            .setPlaceholder('How much of a passage shows')
            .addOptions(PASSIVE_DETAIL_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === detailValue)
            ))
    );

    return [container, selectRow, channelsRow, styleRow, pagerRow, detailRow];
}
