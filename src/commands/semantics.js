import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 3800;
const COLLECTOR_TIMEOUT_MS = 600_000;
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
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 🧠 Semantic Relations — "${rawWord}"${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunks[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'}${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`
        ));

    const components = [container];

    if (totalPages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('page_back')
                .setEmoji({ name: '◀️' })
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === 0),
            new ButtonBuilder()
                .setCustomId('page_next')
                .setEmoji({ name: '▶️' })
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === totalPages - 1)
        ));
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

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetSemanticRelations',
                params: { word },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            let apiResponseData;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                const response = await axios.request({ ...options, signal: controller.signal });
                clearTimeout(timeoutId);
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
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildSemanticsPage({ chunks, pageIdx, totalPages, rawWord })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
                    else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
                    await i.editReply({
                        flags,
                        components: buildSemanticsPage({ chunks, pageIdx, totalPages, rawWord })
                    });
                } catch (err) {
                    logger.error(`[Semantics Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildSemanticsPage({ chunks, pageIdx, totalPages, rawWord, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Semantics Command] End error: ${err.message}`);
                    }
                }
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
