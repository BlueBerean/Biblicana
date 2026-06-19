import {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    MessageFlags,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { renderBibleEphemeral } from '../utils/bibleRenderer.js';
import logger from '../utils/logger.js';

// Message context-menu: right-click any message → Apps → "Look up scripture".
// Parses scripture references from the targeted message's content and shows
// the first one via the same ephemeral bible renderer that the /bible command
// uses. Works anywhere the user has Biblicana installed (guild or user install).
export default {
    data: new ContextMenuCommandBuilder()
        .setName('Look up scripture')
        .setType(ApplicationCommandType.Message)
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction, database) {
        const target = interaction.targetMessage;
        // Context-menu commands on bot messages run on the bot's content too,
        // including BibleBot embeds — check embed text in addition to .content.
        const searchText = [
            target.content || '',
            ...(target.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean)),
        ].join(' ');

        const refs = parseScriptureRefs(searchText);
        if (refs.length === 0) {
            return interaction.reply({
                content: '🔍 No scripture references found in that message.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // Pick the first ref with a concrete verse; fall back to the first ref
        // at all (chapter-only). renderBibleEphemeral handles both.
        const ref = refs.find(r => r.startVerse != null) ?? refs[0];

        let translation = 'BSB';
        try {
            const pref = await database.getUserValue(interaction.user.id);
            if (pref?.translation) translation = pref.translation;
        } catch { /* noop */ }

        try {
            await renderBibleEphemeral({
                interaction,
                bookId: ref.bookId,
                chapter: ref.chapter,
                startVerse: ref.startVerse ?? 1,
                endVerse: ref.endVerse ?? null,
                translation,
            });

            if (refs.length > 1) {
                const extras = refs.slice(1, 4).map(r => r.raw).join(', ');
                await interaction.followUp({
                    content: `-# Also found in that message: ${extras}${refs.length > 4 ? ` (+${refs.length - 4} more)` : ''} — right-click again or use \`/bible\` to look them up.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (err) {
            logger.error(`[CtxLookup] Render failed: ${err.message}`);
            if (!interaction.replied) {
                try {
                    await interaction.reply({ content: '⚠️ Could not load that reference.', flags: MessageFlags.Ephemeral });
                } catch { /* expired */ }
            }
        }
    },
};
