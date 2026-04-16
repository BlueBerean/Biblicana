import { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { placesWrapper } from '../utils/studyHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;
const MAX_DESC_LENGTH = 2500;

function generateFooter(page, maxPages) {
    const pageText = maxPages > 1 ? ` | Result ${page + 1}/${maxPages}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT}${pageText}`,
        iconURL: process.env.EMBEDICONURL
    };
}

const createActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('◀️')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('▶️')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage >= totalPages - 1)
    );

function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '' };
    const parts = uniqueName.split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');
    return { name, firstRef: ref.replace(/\./g, ' ') };
}

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 3) + '...';
}

function buildMapsLink(lonlat) {
    if (!lonlat) return null;
    const parts = lonlat.split(',').map(s => s.trim());
    if (parts.length !== 2) return null;
    const [lat, lon] = parts;
    if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) return null;
    return `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('places')
        .setDescription('Look up a biblical location (Jerusalem, Bethel, Bethlehem, etc.)')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the place (e.g., Jerusalem, Bethel, Bethlehem)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawName = swearWordFilter(interaction.options.getString('name').trim());
            if (!rawName) {
                return interaction.editReply({ content: 'Please provide a valid place name.', ephemeral: true });
            }

            logger.info(`[Places Command] Search: "${rawName}"`);
            const results = await placesWrapper.search(rawName);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    content: `❌ No biblical place found matching "${rawName}". Try names like Jerusalem, Bethel, Nazareth, Jericho.`,
                    ephemeral: true
                });
            }

            logger.info(`[Places Command] Found ${results.length} match(es)`);

            let currentPage = 0;
            const totalPages = results.length;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const buildEmbed = (idx) => {
                const p = results[idx];
                const { name, firstRef } = displayName(p.unique_name);
                const displayTitle = p.openbible_name || name;

                const embed = new EmbedBuilder()
                    .setTitle(`📍 ${displayTitle}`)
                    .setDescription(truncate(p.ext_description || p.short_description || 'No description available.', MAX_DESC_LENGTH))
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE);

                const fields = [];
                if (firstRef) fields.push({ name: '📖 First Mention', value: firstRef, inline: true });
                if (p.uStrong) fields.push({ name: "Strong's", value: p.uStrong, inline: true });

                const mapsLink = buildMapsLink(p.lonlat);
                if (mapsLink) {
                    fields.push({ name: '🗺 Coordinates', value: `[${p.lonlat}](${mapsLink})`, inline: false });
                }

                const externalLinks = [];
                if (p.wikidata) externalLinks.push(`[Wikidata](${p.wikidata})`);
                if (p.pleiades) externalLinks.push(`[Pleiades](${p.pleiades})`);
                if (externalLinks.length > 0) {
                    fields.push({ name: '🔗 References', value: externalLinks.join(' • '), inline: false });
                }

                embed.addFields(fields).setFooter(generateFooter(idx, totalPages));
                return embed;
            };

            const message = await interaction.editReply({
                embeds: [buildEmbed(currentPage)],
                components: totalPages > 1 ? [createActionRow(currentPage, totalPages)] : []
            });

            if (totalPages <= 1) return;

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') currentPage = Math.max(0, currentPage - 1);
                    else if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                    await i.editReply({ embeds: [buildEmbed(currentPage)], components: [createActionRow(currentPage, totalPages)] });
                } catch (collectError) {
                    logger.error(`[Places Command] Collector error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                const finalComponents = createActionRow(currentPage, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(e => {
                    if (e.code !== 10008) logger.error(`[Places Command] Error disabling components: ${e}`);
                });
            });
        } catch (error) {
            logger.error(`[Places Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: '❌ Sorry, an unexpected error occurred.', embeds: [], components: [], ephemeral: true });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Places Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
