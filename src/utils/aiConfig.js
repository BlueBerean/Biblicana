import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
} from 'discord.js';
import { AI_MEMORY_SCOPES } from '../database/schemas/guild.js';
import { accentColor, footerLine, SUPPORT_INVITE, PRIVACY_URL, TERMS_URL } from './theme.js';
import logger from './logger.js';

export const AI_OPTIONS = [
    {
        value: 'on',
        label: 'AI chat: On',
        description: 'Biblicana responds to @mentions and replies with grounded answers.',
    },
    {
        value: 'off',
        label: 'AI chat: Off (default)',
        description: 'Biblicana ignores @mentions. Slash commands still work.',
    },
];

export const AI_MEMORY_SCOPE_OPTIONS = [
    {
        value: 'channel',
        label: 'Shared per-channel memory (default)',
        description: 'Multiple users in a channel build one conversation with the bot.',
    },
    {
        value: 'user',
        label: 'Private per-user memory',
        description: 'Each user has their own isolated conversation thread.',
    },
];

export async function saveAiEnabled(database, guildId, enabled) {
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, aiEnabled: Boolean(enabled) };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[AiConfig] Save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function readAiEnabled(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        return Boolean(g?.aiEnabled);
    } catch (err) {
        logger.debug(`[AiConfig] Read failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function saveAiMemoryScope(database, guildId, scope) {
    if (!AI_MEMORY_SCOPES.includes(scope)) {
        throw new Error(`Invalid AI memory scope: ${scope}`);
    }
    try {
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, aiMemoryScope: scope };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[AiConfig] Scope save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function readAiMemoryScope(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (g?.aiMemoryScope && AI_MEMORY_SCOPES.includes(g.aiMemoryScope)) {
            return g.aiMemoryScope;
        }
    } catch (err) {
        logger.debug(`[AiConfig] Scope read failed for guild=${guildId}: ${err.message}`);
    }
    return 'channel';  // default: multiplayer
}

// Discord's ChannelSelectMenu caps at 25 selections. Also the practical ceiling
// for an allowlist — beyond that, "AI everywhere except a few" is the better UX
// (not built yet; see FOLLOWUPS if that becomes a real ask).
export const AI_CHANNELS_MAX = 25;

export async function saveAiChannels(database, guildId, channelIds) {
    try {
        // De-dupe + coerce to strings; cap at the Discord select ceiling.
        const clean = [...new Set((channelIds ?? []).map(String))].slice(0, AI_CHANNELS_MAX);
        const existing = await database.getGuildValue(guildId) ?? {};
        const merged = { ...existing, id: guildId, aiChannels: clean };
        await database.setGuildValue(guildId, merged);
        return true;
    } catch (err) {
        logger.error(`[AiConfig] Channels save failed for guild=${guildId}: ${err.message}`);
        return false;
    }
}

export async function readAiChannels(database, guildId) {
    try {
        const g = await database.getGuildValue(guildId);
        if (Array.isArray(g?.aiChannels)) return g.aiChannels.map(String);
    } catch (err) {
        logger.debug(`[AiConfig] Channels read failed for guild=${guildId}: ${err.message}`);
    }
    return [];  // default: no restriction (all channels)
}

/**
 * Is AI chat allowed to fire in this channel, given the guild's allowlist?
 * EMPTY allowlist → allowed everywhere (the default). Otherwise the channel's
 * own id must be listed, OR its parent's (so threads inherit the parent
 * channel's allowance without the admin having to list every thread).
 * Only gates the @mention/reply conversation — never slash commands.
 */
export function isAiChannelAllowed(allowedChannelIds, channel) {
    if (!allowedChannelIds || allowedChannelIds.length === 0) return true;
    if (!channel) return false;
    if (allowedChannelIds.includes(channel.id)) return true;
    if (channel.parentId && allowedChannelIds.includes(channel.parentId)) return true;
    return false;
}

/**
 * Build the /config ai panel — the canonical place admins learn what AI
 * chat does, how memory works, and where to get support. Shows current
 * enabled state + memory scope with a select menu for each.
 */
export function buildAiConfigView({ currentEnabled = false, currentMemoryScope = 'channel', currentChannels = [] }) {
    const currentToggleValue = currentEnabled ? 'on' : 'off';
    const currentToggleLabel = AI_OPTIONS.find(o => o.value === currentToggleValue).label;
    const currentScopeLabel = AI_MEMORY_SCOPE_OPTIONS.find(o => o.value === currentMemoryScope)?.label ?? currentMemoryScope;
    const channelsSummary = currentChannels.length === 0
        ? 'All channels'
        : currentChannels.map(id => `<#${id}>`).join(' ');

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        // Header + current state snapshot.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '## 🤖 Biblicana · AI Chat',
                '',
                `**State:** ${currentToggleLabel}`,
                `**Memory:** ${currentScopeLabel}`,
                `**Channels:** ${channelsSummary}`,
            ].join('\n')
        ))
        // How it works — what triggers a response + what grounds it.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### How it works',
                'When enabled, Biblicana responds in two ways:',
                '• You **@mention** Biblicana in a server channel',
                '• You **reply** to any of Biblicana\'s AI chat messages (no mention needed)',
                '',
                'Every response is grounded in Biblicana\'s own commentary database — **334 Early Church Fathers** and **six classical commentators** (Gill, Henry, Clarke, Jamieson-Fausset-Brown, Keil & Delitzsch, Tyndale). Reference a specific verse like `John 3:16` and the response will synthesize what Augustine, Adam Clarke, and others actually wrote — not GPT-4o-mini\'s generic training data.',
                '',
                '*Replies to Biblicana\'s structured outputs (welcome card, verse cards, commentary panels, etc.) are ignored — AI chat only engages on replies to its own conversational messages.*',
            ].join('\n')
        ))
        // Channel restriction — where the AI conversation is allowed.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Where it responds',
                'By default the AI conversation works in **every channel**. Use the channel picker below to **restrict it to specific channels** — pick the channels where the AI is *allowed* to chat, and it will stay silent everywhere else. Clear the selection to allow it everywhere again.',
                '',
                '*This only affects the **@mention / reply** conversation. `/find`, `/web`, and every other slash command keep working in all channels regardless. Threads inherit their parent channel.*',
            ].join('\n')
        ))
        // Memory scope — the meaningful choice.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Memory scope — why it matters',
                'Biblicana remembers the **last ~10 turns** of conversation for **1 hour** of inactivity, then memory auto-expires. Two modes:',
                '',
                '**🔗 Shared per-channel (default)**',
                'Everyone chatting with Biblicana in a channel builds **one continuous conversation**. If Alice asks about John 3:16 and Bob later follows up with "can you expand?", Biblicana remembers Alice\'s original question and responds aware of both speakers. Great for group Bible study.',
                '',
                '**🔒 Private per-user**',
                'Each user has their own **isolated thread**. Alice and Bob can\'t see each other\'s chat history with the bot. Better for sensitive questions or intimate servers.',
            ].join('\n')
        ))
        // Your data, your control.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Your data, your control',
                '• Use `/forget` to erase conversation history for your current scope',
                '• Memory auto-expires after 1 hour of inactivity',
                '• History lives in Redis only — no long-term Postgres persistence, and it never leaves Biblicana\'s server',
                '• Rate limit: **20 AI chats per user per hour** (slash commands remain unlimited)',
            ].join('\n')
        ))
        // Support + feedback + legal.
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### Bug reports · Questions · Suggestions',
                `Join the Biblicana support server: ${SUPPORT_INVITE}`,
                '',
                `**Data handling**: see our [Privacy Policy](${PRIVACY_URL}) for details on how AI chat messages and memory are processed. [Terms of Service](${TERMS_URL}).`,
                '',
                footerLine('Only admins with Manage Server can change these settings.'),
            ].join('\n')
        ));

    const toggleRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:ai')
            .setPlaceholder('Toggle AI chat')
            .addOptions(AI_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentToggleValue)
            ))
    );

    const scopeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('config:aiscope')
            .setPlaceholder('Memory scope')
            .addOptions(AI_MEMORY_SCOPE_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentMemoryScope)
            ))
    );

    // Channel allowlist picker. minValues 0 so the admin can clear it back to
    // "all channels". Pre-selects the current allowlist; deleted channels in
    // default_values are ignored by Discord. Only GuildText/Announcement — threads
    // inherit their parent via isAiChannelAllowed, so no need to list them here.
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('config:ai:channels')
        .setPlaceholder(currentChannels.length
            ? `AI limited to ${currentChannels.length} channel${currentChannels.length === 1 ? '' : 's'} — edit or clear`
            : 'AI allowed everywhere — pick channels to restrict')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(AI_CHANNELS_MAX);
    if (currentChannels.length > 0) {
        channelSelect.setDefaultChannels(...currentChannels);
    }
    const channelsRow = new ActionRowBuilder().addComponents(channelSelect);

    return [container, toggleRow, scopeRow, channelsRow];
}
