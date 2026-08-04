import {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    TextDisplayBuilder,
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

        // ACK FIRST. Every branch below reads guild config from Neon before it
        // can render anything, so there is no fast path — on a cold endpoint
        // this is exactly the shape that produced "This interaction failed"
        // during the 2026-07-19 outage.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

        try {
            if (sub === 'passive') {
                const currentPassiveMode = await readPassiveMode(database, interaction.guildId);
                return interaction.editReply({
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
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildAiConfigView({ currentEnabled, currentMemoryScope, currentChannels }),
                });
            }
            if (sub === 'daily') {
                const current = await readDailyVerseConfig(database, interaction.guildId);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildDailyVerseConfigView({ current }),
                });
            }
            // V2 components, not `content` — the defer above locked the shape.
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [new TextDisplayBuilder().setContent(`Unknown subcommand: ${sub}`)],
            });
        } catch (err) {
            logger.error(`[Config Command] Failed to render ${sub} panel: ${err.message}`);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new TextDisplayBuilder().setContent('⚠️ Could not load configuration right now.')],
                });
            } catch { /* expired */ }
        }
    },
};
