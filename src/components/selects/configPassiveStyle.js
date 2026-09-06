import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    savePassivePaginate,
    readPassiveMode,
    readPassiveChannels,
    readPassivePagerPrivate,
    readPassiveDetail,
    buildConfigView,
    PASSIVE_STYLE_OPTIONS,
} from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for the auto-post layout choice. customId
// "config:passive:style". Chooses between separate cards (the default, capped
// at 3 references) and a single paginated card with no cap.
export default {
    id: 'config:passive:style',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:passive:style') return;

        const picked = interaction.values?.[0];
        if (picked !== 'cards' && picked !== 'paginated') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change the auto-post layout.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'Passive detection is a per-server setting — this has no effect in DMs.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const paginate = picked === 'paginated';
        const saved = await savePassivePaginate(database, interaction.guildId, paginate);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = PASSIVE_STYLE_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const [currentPassiveMode, currentChannels, currentPagerPrivate, currentDetail] = await Promise.all([
                readPassiveMode(database, interaction.guildId),
                readPassiveChannels(database, interaction.guildId),
                readPassivePagerPrivate(database, interaction.guildId),
                readPassiveDetail(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildConfigView({ currentPassiveMode, currentChannels, currentPaginate: paginate, currentPagerPrivate, currentDetail }),
            });

            // This setting only does anything in autopost. Saying so up front
            // beats an admin switching layouts in react mode and concluding the
            // setting is broken when nothing changes.
            const notAutopost = currentPassiveMode !== 'autopost'
                ? `\n\n-# Only applies to the **auto-post** mode. This server is set to **${currentPassiveMode}**, so nothing will look different until you switch.`
                : '';
            const confirmation = paginate
                ? `✅ Auto-post layout set to **${pickedLabel}** — every reference in a message is now browsable with ◀ ▶ buttons, with no 3-reference cap.${notAutopost}`
                : `✅ Auto-post layout set to **${pickedLabel}** — up to 3 references per message, each with its own card.${notAutopost}`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config Passive Style] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
