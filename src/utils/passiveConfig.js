import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
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

/**
 * Build the compact /config view — title, current-state line, select menu.
 * Deliberately smaller than the welcome card: admins running /config don't
 * need the onboarding demo buttons, just the knob.
 */
export function buildConfigView({ currentPassiveMode = 'silent' }) {
    const currentLabel = PASSIVE_MODE_OPTIONS.find(o => o.value === currentPassiveMode)?.label ?? currentPassiveMode;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ Biblicana · Passive Detection'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                `**Current mode:** ${currentLabel}`,
                '',
                'When a user types a scripture reference in chat, what should Biblicana do?',
                '*Changes apply immediately.*',
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

    return [container, selectRow];
}
