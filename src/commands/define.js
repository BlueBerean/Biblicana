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
import swearWordFilter from '../utils/filter.js';
import { strongsWrapper } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

const ITEMS_PER_PAGE = 5;
const COLLECTOR_TIMEOUT_MS = 600_000;
const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;
const MAX_DEFINITION_CHARS = 800;

function buildDefinePage({ items, pageIdx, totalPages, lexiconId, rawWord, disableNav = false }) {
    const accentColor = lexiconId === 'Greek' ? GREEK_COLOR : HEBREW_COLOR;
    const strongsPrefix = lexiconId === 'Greek' ? 'G' : 'H';
    const start = pageIdx * ITEMS_PER_PAGE;
    const pageItems = items.slice(start, start + ITEMS_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const entryLines = pageItems.map((item, idx) => {
        const globalNum = start + idx + 1;
        const strongsId = item.strongs ? `${strongsPrefix}${item.strongs}` : 'N/A';
        const definition = lexiconId === 'Greek'
            ? (item.definition || item.strong_def || 'No definition available.')
            : (item.strong_def || 'No definition available.');
        const shortDef = definition.length > MAX_DEFINITION_CHARS
            ? definition.substring(0, MAX_DEFINITION_CHARS - 1) + '…'
            : definition;

        return [
            `### ${globalNum}. ${strongsId}`,
            `**Original:** ${item.unicode || 'N/A'}`,
            `**Transliteration:** ${item.translit || item.xlit || 'N/A'}`,
            '',
            `**Definition:** ${shortDef}`,
            '―――――――'
        ].join('\n');
    });

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📚 ${lexiconId} Word Study — "${rawWord}"${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(entryLines.join('\n\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${lexiconId} Lexicon | ${items.length} result${items.length === 1 ? '' : 's'}${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`
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
        .setName('define')
        .setDescription('Look up the meaning of words in Hebrew or Greek')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('lexiconid')
                .setDescription('Choose Hebrew or Greek lexicon')
                .setRequired(true)
                .addChoices(
                    { name: '🔵 Hebrew', value: 'Hebrew' },
                    { name: '🟣 Greek', value: 'Greek' }
                ))
        .addStringOption(option =>
            option.setName('word')
                .setDescription('Enter an English word or Strong\'s number (e.g., H1234 or G123)')
                .setRequired(true)
                .setMaxLength(100)),

    async execute(interaction) {
        const lexiconId = interaction.options.getString('lexiconid');
        const rawWord = interaction.options.getString('word').trim();
        const word = swearWordFilter(rawWord);

        if (!word) {
            return interaction.reply({ content: 'Please provide a valid word or Strong\'s number.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const strongsRegex = /^[HGhg]\d+$/i;
            const isStrongsNumber = strongsRegex.test(word);

            let items = [];
            try {
                if (isStrongsNumber) {
                    logger.info(`[Define Command] Fetching by Strong's ID: ${word} in ${lexiconId}`);
                    const singleResult = await strongsWrapper.getStrongsId(lexiconId, word);
                    if (singleResult) items = [singleResult];
                } else {
                    logger.info(`[Define Command] Fetching by English word: ${word} in ${lexiconId}`);
                    items = await strongsWrapper.getStrongsEnglish(lexiconId, word) || [];
                }
            } catch (fetchError) {
                logger.error(`[Define Command] Fetch error: ${fetchError.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Error communicating with the lexicon database. Please try again later.`
                    )]
                });
            }

            items = items.filter(item => item && item.strongs);
            if (items.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No results found for "${word}" in the ${lexiconId} lexicon.`
                    )]
                });
            }

            const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildDefinePage({ items, pageIdx, totalPages, lexiconId, rawWord })
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
                        components: buildDefinePage({ items, pageIdx, totalPages, lexiconId, rawWord })
                    });
                } catch (err) {
                    logger.error(`[Define Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildDefinePage({ items, pageIdx, totalPages, lexiconId, rawWord, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Define Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Define Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ An unexpected error occurred while processing your request.`
                    )]
                });
            } catch (replyError) {
                logger.error(`[Define Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};
