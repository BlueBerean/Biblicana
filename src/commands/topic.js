import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import swearWordFilter from '../utils/filter.js';
import logger from '../utils/logger.js';
import { getBookId } from '../utils/bibleHelper.js';
import 'dotenv/config';

const RESULTS_PER_PAGE = 6;
const MAX_RESULTS_FROM_API = 30;
const MAX_CONTEXT_CHARS = 80;
const MAX_TEXT_CHARS = 500;
const COLLECTOR_TIMEOUT_MS = 600_000;
const API_TIMEOUT_MS = 8000;

// Parses context strings like "Matthew 5:17", "1 Corinthians 13:4-7", etc.
// Returns null for non-standard / non-parseable contexts.
function parseContextRef(context) {
    if (!context) return null;
    const firstChunk = context.split(/[;,]/)[0].trim();
    const match = firstChunk.match(/^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+):(\d+)(?:-(\d+))?/);
    if (!match) return null;
    const bookId = getBookId(match[1].trim());
    if (!bookId) return null;
    const chapter = parseInt(match[2]);
    const startVerse = parseInt(match[3]);
    const endVerse = match[4] ? parseInt(match[4]) : startVerse;
    if (isNaN(chapter) || isNaN(startVerse)) return null;
    return { bookId, chapter, startVerse, endVerse };
}

function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
}

function buildTopicPage({ results, pageIdx, totalPages, rawTopic, disableNav = false }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const start = pageIdx * RESULTS_PER_PAGE;
    const pageResults = results.slice(start, start + RESULTS_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📚 Topic Study: ${rawTopic}${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `*Relevant commentaries and insights. Tap ${pageResults.some(r => r.ref) ? 'Open on any entry to view its passage, or ' : ''}the Disclaimer button for AI-sourced caveats.*`
        ));

    pageResults.forEach((result, localIdx) => {
        const globalIdx = start + localIdx;
        const contextLabel = truncate(result.context || 'Context unavailable', MAX_CONTEXT_CHARS);
        const body = truncate(result.text || 'Text unavailable', MAX_TEXT_CHARS);
        const sectionText = `**${contextLabel}**\n${body}`;

        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(sectionText));

        if (result.ref) {
            // 7th part keeps custom_ids unique when the same context appears
            // in multiple commentary results on the same page.
            const customId = `openverse:bible:${result.ref.bookId}:${result.ref.chapter}:${result.ref.startVerse}:${result.ref.endVerse}:${globalIdx}`;
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(customId)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            // Unparseable context — keep visual alignment with disabled button.
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`topic:noop:${globalIdx}`)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        }
        container.addSectionComponents(section);
    });

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${results.length} result${results.length === 1 ? '' : 's'}${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`
    ));

    const components = [container];

    // Combined bottom row: pagination (if needed) + disclaimer
    const rowButtons = [];
    if (totalPages > 1) {
        rowButtons.push(
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
        );
    }
    rowButtons.push(
        new ButtonBuilder()
            .setCustomId('bias_alert')
            .setEmoji({ name: '💡' })
            .setLabel('Disclaimer')
            .setStyle(ButtonStyle.Secondary)
    );
    components.push(new ActionRowBuilder().addComponents(...rowButtons));

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('topic')
        .setDescription('Search commentaries related to a specific topic')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic to search commentaries for')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawTopic = interaction.options.getString('topic').trim();
        const topic = swearWordFilter(rawTopic);

        if (!topic) {
            return interaction.reply({ content: 'Please provide a valid topic.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Topic Command] Searching: "${topic}"`);

            const options = {
                method: 'GET',
                url: `https://uncovered-treasure-v1.p.rapidapi.com/search/${encodeURIComponent(topic)}`,
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'uncovered-treasure-v1.p.rapidapi.com'
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
                logger.error(`[Topic Command] API request failed: ${apiError.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Failed to fetch commentary data from the source. Please try again later.`
                    )]
                });
            }

            if (!apiResponseData || !Array.isArray(apiResponseData.results) || apiResponseData.results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No commentaries found related to "${topic}"!`
                    )]
                });
            }

            const results = apiResponseData.results
                .slice(0, MAX_RESULTS_FROM_API)
                .map(r => ({
                    context: r.context?.trim() || '',
                    text: r.text?.trim() || '',
                    ref: parseContextRef(r.context)
                }))
                .filter(r => r.context && r.text);

            if (results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No valid commentaries found related to "${topic}"!`
                    )]
                });
            }

            const totalPages = Math.ceil(results.length / RESULTS_PER_PAGE);
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildTopicPage({ results, pageIdx, totalPages, rawTopic })
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
                        components: buildTopicPage({ results, pageIdx, totalPages, rawTopic })
                    });
                } catch (err) {
                    logger.error(`[Topic Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildTopicPage({ results, pageIdx, totalPages, rawTopic, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Topic Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Topic Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, there was an unexpected error processing your request.`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Topic Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
