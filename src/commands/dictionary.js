import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { dictionaryWrapper } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 3800;

function buildDictionaryPage({ page, pageIdx, totalPages, matchType, rawWord, disableNav = false }) {
    const baseTitle = matchType === 'exact'
        ? `📖 ${page.term} — ${page.source}`
        : `📖 "${page.term}" (mentions "${rawWord}") — ${page.source}`;
    const chunkSuffix = page.totalChunksForResult > 1
        ? ` (${page.chunkIdx + 1}/${page.totalChunksForResult})`
        : '';
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const matchLabel = matchType === 'definition' ? ' | Fallback match' : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${baseTitle}${chunkSuffix}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(page.chunk))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`${page.source}${matchLabel}${pageInfo}`)
        ));

    const components = [container];
    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('dictionary')
        .setDescription("Look up a word in Easton's and Smith's Bible Dictionaries")
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('word')
                .setDescription('The word to look up')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawWord = interaction.options.getString('word').trim();
        const searchWord = swearWordFilter(rawWord);
        if (!searchWord) {
            return interaction.reply({ content: 'Please provide a valid word.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Dictionary Command] Looking up: "${searchWord}"`);
            const { results, matchType } = await dictionaryWrapper.search(searchWord);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No definition found for "${rawWord}" in Easton's or Smith's Bible Dictionary.`
                    )]
                });
            }

            logger.info(`[Dictionary Command] Found ${results.length} result(s), matchType=${matchType}`);

            // Flatten: one page per chunk per result
            const pages = [];
            for (const r of results) {
                const chunks = splitString(r.definition || '(No definition text)', MAX_CHARS_PER_CHUNK);
                chunks.forEach((chunk, chunkIdx) => {
                    pages.push({
                        chunk,
                        term: r.term,
                        source: r.source_name,
                        chunkIdx,
                        totalChunksForResult: chunks.length,
                    });
                });
            }

            if (pages.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An error occurred while formatting the definition.`)]
                });
            }

            const totalPages = pages.length;
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildDictionaryPage({ page: pages[0], pageIdx: 0, totalPages, matchType, rawWord })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Dictionary Command]',
                render: (pageIdx, { disableNav }) =>
                    buildDictionaryPage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawWord, disableNav })
            });
        } catch (error) {
            logger.error(`[Dictionary Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An unexpected error occurred.`)]
                });
            } catch (replyError) {
                logger.error(`[Dictionary Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
