import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROPHS_PER_PAGE = 7;
const PAGINATION_TIMEOUT_MS = 180000;

const createErrorEmbed = (title, description) => {
    const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0xFF0000;
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description.substring(0, 4090))
        .setColor(embedColor)
        .setTimestamp();
};

function generateProphecyPageFooter(page, maxPages) {
    return {
        text: `Page ${page + 1}/${maxPages}`,
        iconURL: process.env.EMBEDICONURL
    };
}

const createProphecyActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage >= totalPages - 1)
    );

export default {
    data: new SlashCommandBuilder()
        .setName('propheciesofjesus')
        .setDescription('Displays prophecies about Jesus fulfilled in Scripture (paginated).'),

    async execute(interaction) {
        await interaction.deferReply();

        const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x00FF00;

        let prophecies = [];
        try {
            const filePath = path.join(__dirname, '..', '..', 'data', 'prophecies.json');
            logger.info(`[/PropheciesOfJesus Command] Reading prophecies from: ${filePath}`);
            const fileContent = fs.readFileSync(filePath, 'utf8');
            prophecies = JSON.parse(fileContent);

            if (!Array.isArray(prophecies)) {
                throw new Error('Prophecies data is not an array.');
            }

            logger.info(`[/PropheciesOfJesus Command] Successfully loaded ${prophecies.length} prophecies from file.`);
        } catch (error) {
            logger.error(`[/PropheciesOfJesus Command] Error reading or parsing prophecies.json: ${error.message}`, error.stack);
            const errorEmbed = createErrorEmbed('🧪 File Error', 'Could not load the prophecy data file. Please check server logs.');
            return interaction.editReply({ embeds: [errorEmbed], ephemeral: true });
        }

        if (prophecies.length === 0) {
            const errorEmbed = createErrorEmbed('🧪 No Data', 'The prophecies data file is empty.');
            return interaction.editReply({ embeds: [errorEmbed] });
        }

        let currentPageIndex = 0;
        const totalPages = Math.ceil(prophecies.length / PROPHS_PER_PAGE);

        const createProphecyPageEmbed = (pageIndex) => {
            const startIndex = pageIndex * PROPHS_PER_PAGE;
            const currentProphecies = prophecies.slice(startIndex, startIndex + PROPHS_PER_PAGE);

            const description = currentProphecies.map(p =>
                `**${p['OT Reference']}:** ${p.Description}\n*Fulfillment: ${p['NT Fulfillment'] || 'N/A'}*`
            ).join('\n\n');

            return new EmbedBuilder()
                .setTitle('📜 Prophecies Fulfilled in Jesus')
                .setDescription(description || 'No prophecies on this page.')
                .setColor(embedColor)
                .setFooter(generateProphecyPageFooter(pageIndex, totalPages))
                .setTimestamp();
        };

        const initialEmbed = createProphecyPageEmbed(currentPageIndex);
        const initialRow = createProphecyActionRow(currentPageIndex, totalPages);

        try {
            const message = await interaction.editReply({
                embeds: [initialEmbed],
                components: totalPages > 1 ? [initialRow] : [],
                fetchReply: true
            });

            if (totalPages <= 1) return;

            const filter = i =>
                i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');

            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: PAGINATION_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate().catch(e => logger.warn(`[/PropheciesOfJesus Command] Failed to defer update: ${e.message}`));

                    if (i.customId === 'page_next') {
                        currentPageIndex++;
                    } else if (i.customId === 'page_back') {
                        currentPageIndex--;
                    }

                    currentPageIndex = Math.max(0, Math.min(currentPageIndex, totalPages - 1));

                    const updatedEmbed = createProphecyPageEmbed(currentPageIndex);
                    const updatedRow = createProphecyActionRow(currentPageIndex, totalPages);

                    try {
                        await i.editReply({
                            embeds: [updatedEmbed],
                            components: [updatedRow]
                        });
                    } catch (editError) {
                        logger.error(`[/PropheciesOfJesus Command] Error during editReply: ${editError.message}`);
                        try {
                            await message.edit({
                                embeds: [updatedEmbed],
                                components: [updatedRow]
                            });
                        } catch (messageEditError) {
                            logger.error(`[/PropheciesOfJesus Command] Failed fallback message edit: ${messageEditError.message}`);
                        }
                    }
                } catch (collectError) {
                    logger.error(`[/PropheciesOfJesus Command] Error updating prophecy pagination: ${collectError}`);
                }
            });

            collector.on('end', () => {
                logger.info('[/PropheciesOfJesus Command] Prophecy pagination collector ended.');
                if (!message.deleted) {
                    const finalRow = createProphecyActionRow(currentPageIndex, totalPages, true);
                    message.edit({ components: [finalRow] }).catch(editError => {
                        if (editError.code !== 10008) {
                            logger.warn(`[/PropheciesOfJesus Command] Error disabling buttons after prophecy timeout: ${editError.message}`);
                        }
                    });
                }
            });
        } catch (error) {
            logger.error(`[/PropheciesOfJesus Command] Error during initial message send/edit: ${error.message}`, error.stack);
            try {
                if (interaction.channel) {
                    const errorEmbed = createErrorEmbed('🧪 Command Error', 'An error occurred while displaying the prophecies.');
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                    } else {
                        await interaction.editReply({ embeds: [errorEmbed], ephemeral: true });
                    }
                }
            } catch (followUpError) {
                logger.error(`[/PropheciesOfJesus Command] Failed to send error followup: ${followUpError.message}`);
            }
        }
    }
};
