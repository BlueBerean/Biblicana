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
import { dictionaryWrapper } from '../utils/studyHelper.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 3800;
const COLLECTOR_TIMEOUT_MS = 600_000;

function buildDictionaryPage({ page, pageIdx, totalPages, matchType, rawWord, matchedSources, missingSources, disableNav = false }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;

    const baseTitle = matchType === 'exact'
        ? `📖 ${page.term} — ${page.source}`
        : `📖 "${page.term}" (mentions "${rawWord}") — ${page.source}`;
    const chunkSuffix = page.totalChunksForResult > 1
        ? ` (${page.chunkIdx + 1}/${page.totalChunksForResult})`
        : '';
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const matchLabel = matchType === 'definition' ? ' | Fallback match' : '';
    const footerText = `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${page.source}${matchLabel}${pageInfo}`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${baseTitle}${chunkSuffix}`));

    // Surface which dictionaries lacked an entry so the user doesn't think
    // pagination is broken when only one source matched.
    if (missingSources.length > 0) {
        const label = missingSources.length === 1
            ? `*${missingSources[0]} doesn't have an entry for "${rawWord}".*`
            : `*${missingSources.join(' and ')} don't have entries for "${rawWord}".*`;
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(label));
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(page.chunk));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

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

            // Compute which configured dictionaries matched vs missed this term.
            const KNOWN_SOURCES = ["Easton's Bible Dictionary", "Smith's Bible Dictionary"];
            const matchedSources = [...new Set(results.map(r => r.source_name))];
            const missingSources = KNOWN_SOURCES.filter(s => !matchedSources.includes(s));

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
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildDictionaryPage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawWord, matchedSources, missingSources })
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
                        components: buildDictionaryPage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawWord, matchedSources, missingSources })
                    });
                } catch (err) {
                    logger.error(`[Dictionary Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildDictionaryPage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawWord, matchedSources, missingSources, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Dictionary Command] End error: ${err.message}`);
                    }
                }
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
