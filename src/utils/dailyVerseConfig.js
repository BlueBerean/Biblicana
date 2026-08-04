import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
} from 'discord.js';
import { accentColor, footerLine } from './theme.js';
import logger from './logger.js';

export const DAILY_ENABLED_OPTIONS = [
    {
        value: 'on',
        label: 'Daily Verse: On',
        description: 'Biblicana posts the verse of the day to the channel you pick.',
    },
    {
        value: 'off',
        label: 'Daily Verse: Off (default)',
        description: 'No auto-posting. /passageoftheday still works on demand.',
    },
];

// Is US Eastern on daylight time at this instant?
//
// Derived from the IANA tz database via Intl rather than hardcoding the
// second-Sunday-of-March rule, so the labels track any future rule change
// (permanent DST is a live legislative proposal) through a tzdata update
// instead of an edit here.
function usIsOnDaylightTime(at) {
    const zoneName = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'short',
    }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
    return zoneName === 'EDT';
}

function hour12(h) {
    if (h === 0) return 'midnight';
    if (h === 12) return 'noon';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// "<local hour> <ZONE>", with a day-shift suffix when that UTC hour falls on a
// different calendar day locally.
function localHint(utcHour, offset, zone) {
    const raw = utcHour + offset;
    const local = ((raw % 24) + 24) % 24;
    const dayShift = raw < 0 ? ' prev day' : raw >= 24 ? ' next day' : '';
    return `${hour12(local)} ${zone}${dayShift}`;
}

/**
 * Hour options 0..23 UTC with timezone hints. Discord's select-menu cap is 25,
 * so 24 fits.
 *
 * MUST be called per render. The previous version was an IIFE evaluated once at
 * module load with standard-time hints hardcoded, which was wrong twice over:
 * every label was an hour off for the ~8 months a year the US is on daylight
 * time, and the array froze at process start, so a bot that booted in January
 * kept serving winter labels until it restarted. This process routinely has
 * uptime measured in weeks, so that was not theoretical — Kenneth picked
 * 15:00 UTC expecting 10am and got 11am EDT.
 *
 * `at` is injectable so the DST behaviour is testable without clock mocking.
 */
export function buildDailyHourOptions(at = new Date()) {
    const dst = usIsOnDaylightTime(at);
    const eastZone = dst ? 'EDT' : 'EST';
    const westZone = dst ? 'PDT' : 'PST';
    const eastOffset = dst ? -4 : -5;
    const westOffset = dst ? -7 : -8;

    return Array.from({ length: 24 }, (_, h) => ({
        value: String(h),
        label: `${String(h).padStart(2, '0')}:00 UTC`,
        description: `${hour12(h)} UTC · ${localHint(h, eastOffset, eastZone)} · ${localHint(h, westOffset, westZone)}`,
    }));
}

export async function saveDailyVerseConfig(database, guildId, patch) {
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const mergedDv = { ...(existing.dailyVerse ?? {}), ...patch };
        const merged = { ...existing, id: guildId, dailyVerse: mergedDv };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[DailyVerseConfig] Save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function readDailyVerseConfig(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        return g?.dailyVerse ?? { enabled: false };
    } catch (err) {
        logger.debug(`[DailyVerseConfig] Read failed for guild=${guildId}: ${err.message}`);
        return { enabled: false };
    }
}

/**
 * Compact /config daily panel: current state + three selects (enabled,
 * channel, hour). Explains what admin configuration does, flags gaps
 * (e.g., "enabled but no channel picked — nothing will post").
 */
export function buildDailyVerseConfigView({ current = {} } = {}) {
    const enabled = Boolean(current.enabled);
    const channelId = current.channelId;
    const hour = typeof current.hour === 'number' ? current.hour : null;

    const enabledLabel = enabled ? '✅ Daily Verse: On' : '⚪ Daily Verse: Off';
    const channelLabel = channelId ? `<#${channelId}>` : '*not set*';
    const hourLabel = hour !== null ? `${String(hour).padStart(2, '0')}:00 UTC` : '*not set*';

    const warnings = [];
    if (enabled && !channelId) warnings.push('⚠️ Enabled but no channel picked — nothing will post.');
    if (enabled && hour === null) warnings.push('⚠️ Enabled but no hour picked — nothing will post.');

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📅 Biblicana · Verse of the Day'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                `**Status:** ${enabledLabel}`,
                `**Channel:** ${channelLabel}`,
                `**Time:** ${hourLabel}`,
                ...(warnings.length ? ['', ...warnings] : []),
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### How it works',
                'Biblicana posts the curated Verse of the Day (from a 365-day calendar — same as `/passageoftheday`) to your chosen channel each day at the hour you pick. The post is formatted identically to `/passageoftheday`, with the four study buttons (Open, Commentary, Cross-refs, Parallel).',
                '',
                '*Bot requires Send Messages + View Channel permissions in the chosen channel.*',
                '*Duplicate posts are prevented by a per-day marker that resets at UTC midnight.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine('Only admins with Manage Server can change these settings.')
        ));

    const enabledRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:daily:enabled')
            .setPlaceholder('Enable or disable daily verse')
            .addOptions(DAILY_ENABLED_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === (enabled ? 'on' : 'off'))
            ))
    );

    const channelRow = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('config:daily:channel')
            .setPlaceholder('Pick a channel for the daily verse')
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setMinValues(1)
            .setMaxValues(1)
    );

    const hourRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:daily:hour')
            .setPlaceholder('Pick an hour (UTC)')
            // Built per render, not read from a module-load constant — see
            // buildDailyHourOptions for why that distinction is load-bearing.
            .addOptions(buildDailyHourOptions().map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(hour !== null && Number(opt.value) === hour)
            ))
    );

    return [container, enabledRow, channelRow, hourRow];
}
