import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    savePassivePagerPrivate,
    readPassiveMode,
    readPassiveChannels,
    readPassivePaginate,
    readPassiveDetail,
    buildConfigView,
    PASSIVE_PAGER_OPTIONS,
} from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for pager privacy. customId "config:passive:pager".
// Chooses whether the page buttons move the public post for everyone or hand
// each reader their own private copy.
export default {
    id: 'config:passive:pager',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:passive:pager') return;

        const picked = interaction.values?.[0];
        if (picked !== 'private' && picked !== 'shared') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change paging.',
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

        const isPrivate = picked === 'private';
        const saved = await savePassivePagerPrivate(database, interaction.guildId, isPrivate);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = PASSIVE_PAGER_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const [currentPassiveMode, currentChannels, currentPaginate, currentDetail] = await Promise.all([
                readPassiveMode(database, interaction.guildId),
                readPassiveChannels(database, interaction.guildId),
                readPassivePaginate(database, interaction.guildId),
                readPassiveDetail(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildConfigView({
                    currentPassiveMode,
                    currentChannels,
                    currentPaginate,
                    currentPagerPrivate: isPrivate,
                    currentDetail,
                }),
            });

            // This does nothing without the paginated layout, and nothing at all
            // in the react-only modes. Say which one is in the way rather than
            // letting an admin conclude the setting is broken.
            let inert = '';
            if (!currentPaginate) {
                inert = '\n\n-# Only applies to the **One card with page buttons** layout. This server is set to separate cards, so there are no page buttons yet.';
            } else if (currentPassiveMode !== 'autopost') {
                inert = `\n\n-# Only applies to the **auto-post** mode. This server is set to **${currentPassiveMode}**, so nothing is posted to page through yet.`;
            }

            const confirmation = isPrivate
                ? `✅ Paging set to **${pickedLabel}** — the post shows a **Browse** button, and each reader who taps it gets their own copy that only they can see.${inert}`
                : `✅ Paging set to **${pickedLabel}** — ◀ ▶ move the post itself for everyone in the channel.${inert}`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config Passive Pager] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
