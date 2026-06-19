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

// Hour options 0..23 UTC. Discord's select-menu cap is 25, so 24 fits.
// Labels include common timezone hints so admins don't have to compute UTC
// conversions in their head for the typical cases.
export const DAILY_HOUR_OPTIONS = (() => {
    const tzHints = {
        // UTC → human hint combining major Christian-population timezones
        0:  'Midnight UTC · 7pm EST prev day',
        1:  '1am UTC · 8pm EST prev day',
        2:  '2am UTC · 9pm EST prev day',
        3:  '3am UTC · 10pm EST prev day',
        4:  '4am UTC · 11pm EST prev day',
        5:  '5am UTC · midnight EST',
        6:  '6am UTC · 1am EST',
        7:  '7am UTC · 2am EST',
        8:  '8am UTC · 3am EST',
        9:  '9am UTC · 4am EST',
        10: '10am UTC · 5am EST',
        11: '11am UTC · 6am EST',
        12: 'Noon UTC · 7am EST · 4am PST',
        13: '1pm UTC · 8am EST · 5am PST',
        14: '2pm UTC · 9am EST · 6am PST',
        15: '3pm UTC · 10am EST · 7am PST',
        16: '4pm UTC · 11am EST · 8am PST',
        17: '5pm UTC · noon EST · 9am PST',
        18: '6pm UTC · 1pm EST · 10am PST',
        19: '7pm UTC · 2pm EST · 11am PST',
        20: '8pm UTC · 3pm EST · noon PST',
        21: '9pm UTC · 4pm EST · 1pm PST',
        22: '10pm UTC · 5pm EST · 2pm PST',
        23: '11pm UTC · 6pm EST · 3pm PST',
    };
    return Array.from({ length: 24 }, (_, h) => ({
        value: String(h),
        label: `${String(h).padStart(2, '0')}:00 UTC`,
        description: tzHints[h],
    }));
})();

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
            .addOptions(DAILY_HOUR_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(hour !== null && Number(opt.value) === hour)
            ))
    );

    return [container, enabledRow, channelRow, hourRow];
}
