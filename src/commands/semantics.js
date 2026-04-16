import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import { fetchIQBible } from '../utils/rapidApi.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 3800;
const API_TIMEOUT_MS = 6000;

function formatRelationType(type) {
    return type.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function getRelationEmoji(type) {
    switch (type.toLowerCase()) {
        case 'synonyms': return '🟢';
        case 'antonyms': return '🔴';
        case 'related_terms': return '🔵';
        case 'broader_terms': return '⬆️';
        case 'narrower_terms': return '⬇️';
        default: return '•';
    }
}

function buildSemanticsPage({ chunks, pageIdx, totalPages, rawWord, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 🧠 Semantic Relations — "${rawWord}"${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunks[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(totalPages > 1 ? `Page ${pageIdx + 1}/${totalPages}` : '')
        ));

    const components = [container];

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('semantics')
        .setDescription('Find semantic relations for a Biblical word or concept')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('word')
                .setDescription('The word you want to find semantic relations for')
                .setRequired(true)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawWord = interaction.options.getString('word').trim();
        const word = swearWordFilter(rawWord);

        if (!word) {
            return interaction.reply({ content: 'Please provide a valid word.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Semantics Command] Looking up: "${word}"`);

            let apiResponseData;
            try {
                const response = await fetchIQBible('GetSemanticRelations', { word }, { timeoutMs: API_TIMEOUT_MS });
                apiResponseData = response.data;
            } catch (apiError) {
                logger.error(`[Semantics Command] API request failed for "${word}": ${apiError.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Failed to fetch semantic relations from the source.`
                    )]
                });
            }

            if (!apiResponseData || typeof apiResponseData !== 'object' || Object.keys(apiResponseData).length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No semantic relations found for "${word}". Try a different word or check spelling.`
                    )]
                });
            }

            let combinedContent = `🔍 Exploring semantic relationships for **${rawWord}**\n\n`;
            let relationsFound = false;

            for (const type in apiResponseData) {
                const words = apiResponseData[type];
                if (words && Array.isArray(words)) {
                    const validWords = words.filter(w => w && typeof w === 'string' && w.trim()).map(w => w.trim());
                    if (validWords.length > 0) {
                        relationsFound = true;
                        const formattedType = formatRelationType(type);
                        const emoji = getRelationEmoji(type);
                        combinedContent += `**${formattedType}:**\n${validWords.map(w => `${emoji} ${w}`).join('\n')}\n\n`;
                    }
                }
            }

            if (!relationsFound) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No valid semantic relations found for "${word}".`
                    )]
                });
            }

            const chunks = splitString(combinedContent.trim(), MAX_CHARS_PER_PAGE);
            const totalPages = chunks.length;
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildSemanticsPage({ chunks, pageIdx: 0, totalPages, rawWord })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Semantics Command]',
                render: (pageIdx, { disableNav }) =>
                    buildSemanticsPage({ chunks, pageIdx, totalPages, rawWord, disableNav })
            });
        } catch (error) {
            logger.error(`[Semantics Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, there was an unexpected error processing your request.`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Semantics Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
