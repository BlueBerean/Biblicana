import {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import { buildConfigView, readPassiveMode } from '../utils/passiveConfig.js';
import { buildAiConfigView, readAiEnabled, readAiMemoryScope, readAiChannels } from '../utils/aiConfig.js';
import { buildDailyVerseConfigView, readDailyVerseConfig } from '../utils/dailyVerseConfig.js';
import logger from '../utils/logger.js';

// /config — admin-only per-guild settings. Uses a subcommand group so future
// additions (/config notifications, /config daily-verse, etc.) slot in
// without breaking the existing surface. Discord hides the whole command
// from non-admins via setDefaultMemberPermissions.
export default {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Server-wide Biblicana settings (admins only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(sub => sub
            .setName('passive')
            .setDescription('Configure passive scripture detection.')
        )
        .addSubcommand(sub => sub
            .setName('ai')
            .setDescription('Configure AI chat (@mentions and replies).')
        )
        .addSubcommand(sub => sub
            .setName('daily')
            .setDescription('Configure daily Verse of the Day auto-post.')
        ),

    async execute(interaction, database) {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'This command is server-only.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'passive') {
                const currentPassiveMode = await readPassiveMode(database, interaction.guildId);
                return interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildConfigView({ currentPassiveMode }),
                });
            }
            if (sub === 'ai') {
                const [currentEnabled, currentMemoryScope, currentChannels] = await Promise.all([
                    readAiEnabled(database, interaction.guildId),
                    readAiMemoryScope(database, interaction.guildId),
                    readAiChannels(database, interaction.guildId),
                ]);
                return interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildAiConfigView({ currentEnabled, currentMemoryScope, currentChannels }),
                });
            }
            if (sub === 'daily') {
                const current = await readDailyVerseConfig(database, interaction.guildId);
                return interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildDailyVerseConfigView({ current }),
                });
            }
            return interaction.reply({
                content: `Unknown subcommand: ${sub}`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Config Command] Failed to render ${sub} panel: ${err.message}`);
            try {
                await interaction.reply({
                    content: '⚠️ Could not load configuration right now.',
                    flags: MessageFlags.Ephemeral,
                });
            } catch { /* expired */ }
        }
    },
};
