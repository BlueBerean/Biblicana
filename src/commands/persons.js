import { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { personsWrapper } from '../utils/studyHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;
const MAX_DESC_LENGTH = 2500;
const MAX_FIELD_LENGTH = 1024;

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

// "Mary_Magdalene_Mat.27.56" -> { name: "Mary Magdalene", firstRef: "Mat 27 56" }
function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '' };
    const parts = uniqueName.split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');
    return { name, firstRef: ref.replace(/\./g, ' ') };
}

function parseJsonArray(field) {
    if (!field) return [];
    try {
        const parsed = JSON.parse(field);
        if (Array.isArray(parsed)) return parsed.filter(x => x && x !== '');
    } catch (e) { /* malformed JSON is non-fatal for display */ }
    return [];
}

function formatRelation(rawField) {
    if (!rawField) return null;
    const d = displayName(rawField);
    return d.name || null;
}

function formatRelations(jsonField) {
    const items = parseJsonArray(jsonField);
    if (items.length === 0) return null;
    return items.map(item => displayName(item).name).join(', ');
}

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 3) + '...';
}

export default {
    data: new SlashCommandBuilder()
        .setName('persons')
        .setDescription('Look up a biblical figure (Aaron, David, Mary, etc.)')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the person (e.g., Aaron, David, Mary Magdalene)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawName = swearWordFilter(interaction.options.getString('name').trim());
            if (!rawName) {
                return interaction.editReply({ content: 'Please provide a valid name.', ephemeral: true });
            }

            logger.info(`[Persons Command] Search: "${rawName}"`);
            const results = await personsWrapper.search(rawName);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    content: `❌ No biblical figure found matching "${rawName}". Try names like Aaron, Abraham, David, Mary, Peter.`,
                    ephemeral: true
                });
            }

            logger.info(`[Persons Command] Found ${results.length} match(es)`);

            let currentPage = 0;
            const totalPages = results.length;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const buildEmbed = (idx) => {
                const p = results[idx];
                const { name, firstRef } = displayName(p.unique_name);

                const embed = new EmbedBuilder()
                    .setTitle(`👤 ${name}`)
                    .setDescription(truncate(p.ext_description || p.short_description || 'No description available.', MAX_DESC_LENGTH))
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE);

                const fields = [];
                if (firstRef) fields.push({ name: '📖 First Mention', value: firstRef, inline: true });
                if (p.tribe) fields.push({ name: '🏛 Tribe', value: p.tribe, inline: true });
                if (p.sex) fields.push({ name: 'Sex', value: p.sex, inline: true });
                if (p.uStrong) fields.push({ name: "Strong's", value: p.uStrong, inline: true });

                const father = formatRelation(p.father);
                const mother = formatRelation(p.mother);
                if (father) fields.push({ name: 'Father', value: father, inline: true });
                if (mother) fields.push({ name: 'Mother', value: mother, inline: true });

                const siblings = formatRelations(p.siblings);
                const partners = formatRelations(p.partners);
                const offspring = formatRelations(p.offspring);
                if (siblings) fields.push({ name: 'Siblings', value: truncate(siblings, MAX_FIELD_LENGTH), inline: false });
                if (partners) fields.push({ name: 'Partners', value: truncate(partners, MAX_FIELD_LENGTH), inline: false });
                if (offspring) fields.push({ name: 'Offspring', value: truncate(offspring, MAX_FIELD_LENGTH), inline: false });

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
                    logger.error(`[Persons Command] Collector error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                const finalComponents = createActionRow(currentPage, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(e => {
                    if (e.code !== 10008) logger.error(`[Persons Command] Error disabling components: ${e}`);
                });
            });
        } catch (error) {
            logger.error(`[Persons Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: '❌ Sorry, an unexpected error occurred.', embeds: [], components: [], ephemeral: true });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Persons Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
