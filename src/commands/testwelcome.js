import {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import { buildWelcomeCard } from '../utils/welcomeCard.js';
import logger from '../utils/logger.js';

// Dev-only: re-posts the welcome card in the current channel. Lets you iterate
// on the card's visual layout in a real Discord context without having to kick
// and re-invite the bot every time. Admin-gated, but also gated from prod by
// never running `pnpm run deployg` for it — keep it out of the global command
// registry. For a proper ship-gate, remove this file or guard the execute with
// a NODE_ENV check before deploying globally.
export default {
    data: new SlashCommandBuilder()
        .setName('testwelcome')
        .setDescription('[Dev] Re-render the welcome card in this channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction, database) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Read stored guild state so the card reflects current settings
        // rather than static defaults (useful for previewing how the card
        // looks for different admin choices).
        let currentMode = 'react_biblebot';
        let currentAiEnabled = false;
        let currentDailyEnabled = false;
        if (interaction.guildId) {
            try {
                const g = await database.getGuildValue(interaction.guildId);
                if (g?.passiveMode) currentMode = g.passiveMode;
                currentAiEnabled = Boolean(g?.aiEnabled);
                currentDailyEnabled = Boolean(g?.dailyVerse?.enabled);
            } catch (err) {
                logger.warn(`[TestWelcome] Could not read guild record: ${err.message}`);
            }
        }

        try {
            await interaction.channel.send({
                flags: MessageFlags.IsComponentsV2,
                components: buildWelcomeCard({
                    currentPassiveMode: currentMode,
                    currentAiEnabled,
                    currentDailyEnabled,
                }),
            });
            await interaction.editReply('✅ Welcome card posted in this channel.');
        } catch (err) {
            logger.error(`[TestWelcome] Send failed: ${err.message}`);
            await interaction.editReply(`❌ Could not post: ${err.message}`);
        }
    },
};
