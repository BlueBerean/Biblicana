import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { buildWelcomeCard } from '../../utils/welcomeCard.js';
import { saveAiEnabled, AI_OPTIONS } from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Welcome-card AI toggle. customId: "welcome:ai". Admin-gated, same as
// the passive selector. When saved, re-renders the full welcome card with
// BOTH the new AI state AND the existing passive mode preserved — otherwise
// touching one selector would visually reset the other.
export default {
    id: 'welcome:ai',
    async execute(interaction, database) {
        if (interaction.customId !== 'welcome:ai') return;

        const picked = interaction.values?.[0];
        if (picked !== 'on' && picked !== 'off') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change AI chat.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content: 'AI chat is a per-server setting — change it from within a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const enabled = picked === 'on';
        const saved = await saveAiEnabled(database, interaction.guildId, enabled);
        if (!saved) {
            return interaction.reply({
                content: '⚠️ Could not save that setting right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = AI_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const existing = await database.getGuildValue(interaction.guildId) ?? {};
            await interaction.update({
                flags: MessageFlags.IsComponentsV2,
                components: buildWelcomeCard({
                    currentPassiveMode: existing.passiveMode ?? 'react_biblebot',
                    currentAiEnabled: enabled,
                    currentDailyEnabled: Boolean(existing.dailyVerse?.enabled),
                }),
            });
            await interaction.followUp({
                content: enabled
                    ? `✅ **${pickedLabel}** — I'll respond when you @mention me or reply to my messages. Use \`/forget\` anytime to erase our chat history.`
                    : `✅ **${pickedLabel}** — I'll ignore @mentions here. Slash commands still work.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Welcome AI Select] Update/followUp failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
