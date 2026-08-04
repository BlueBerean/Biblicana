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
import { placesWrapper, displayName } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_DESC_LENGTH = 3000;

// displayName now lives in studyHelper.js — see the note in persons.js. The two
// command copies were identical apart from local variable names.

// uStrong format: "G0184", "H1234", or occasionally "H1035G" (compound with
// trailing noise — seen on Bethlehem). Leading zeros are stripped; anything
// after the first complete H#### or G#### match is ignored.
function parseStrongs(uStrong) {
    if (!uStrong) return null;
    const match = uStrong.match(/^([HGhg])0*(\d+)/);
    if (!match) return null;
    const lexicon = match[1].toUpperCase() === 'G' ? 'Greek' : 'Hebrew';
    return { lexicon, strongsId: `${match[1].toUpperCase()}${match[2]}` };
}

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

function buildMapsLink(lonlat) {
    if (!lonlat) return null;
    const parts = lonlat.split(',').map(s => s.trim());
    if (parts.length !== 2) return null;
    const [lat, lon] = parts;
    if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) return null;
    return `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
}

function buildPlacePage({ place, pageIdx, totalPages, disableNav = false }) {
    const { name } = displayName(place.unique_name);
    const displayTitle = place.openbible_name || name;
    const pageInfo = totalPages > 1 ? ` (Result ${pageIdx + 1}/${totalPages})` : '';

    const description = truncate(place.ext_description || place.short_description || '*No description available.*', MAX_DESC_LENGTH);

    const facts = [];
    if (place.uStrong) facts.push(`**Strong's:** ${place.uStrong}`);
    if (place.lonlat) facts.push(`**🧭 Coordinates:** ${place.lonlat}`);

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📍 ${displayTitle}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(description));

    if (facts.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.join('\n')));
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(totalPages > 1 ? `Result ${pageIdx + 1}/${totalPages}` : '')
    ));

    const components = [container];

    // In-app action buttons (Secondary style, route through existing handlers).
    const actionButtons = [];
    const strongs = parseStrongs(place.uStrong);
    if (strongs) {
        actionButtons.push(new ButtonBuilder()
            .setCustomId(`strongs:${strongs.lexicon}:${strongs.strongsId}`)
            .setLabel('Define')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary));
    }
    if (actionButtons.length > 0) {
        components.push(new ActionRowBuilder().addComponents(...actionButtons));
    }

    // Row 2 — external references (Link-style, no custom_id, no handler needed).
    const mapsLink = buildMapsLink(place.lonlat);
    const linkButtons = [];
    if (mapsLink) {
        linkButtons.push(new ButtonBuilder()
            .setLabel('Google Maps')
            .setEmoji({ name: '🗺️' })
            .setStyle(ButtonStyle.Link)
            .setURL(mapsLink));
    }
    if (place.wikidata) {
        linkButtons.push(new ButtonBuilder()
            .setLabel('Wikidata')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Link)
            .setURL(place.wikidata));
    }
    if (place.pleiades) {
        linkButtons.push(new ButtonBuilder()
            .setLabel('Pleiades')
            .setEmoji({ name: '📜' })
            .setStyle(ButtonStyle.Link)
            .setURL(place.pleiades));
    }
    if (linkButtons.length > 0) {
        components.push(new ActionRowBuilder().addComponents(...linkButtons));
    }

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('places')
        .setDescription('Look up a biblical location (Jerusalem, Bethel, Bethlehem, etc.)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the place (e.g., Jerusalem, Bethel, Bethlehem)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawInput = interaction.options.getString('name').trim();
        const rawName = swearWordFilter(rawInput);
        if (!rawName) {
            return interaction.reply({ content: 'Please provide a valid place name.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Places Command] Search: "${rawName}"`);
            const results = await placesWrapper.search(rawName);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No biblical place found matching "${rawName}". Try names like Jerusalem, Bethel, Nazareth, Jericho.`)]
                });
            }

            logger.info(`[Places Command] Found ${results.length} match(es)`);

            const totalPages = results.length;
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPlacePage({ place: results[0], pageIdx: 0, totalPages })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Places Command]',
                render: (pageIdx, { disableNav }) =>
                    buildPlacePage({ place: results[pageIdx], pageIdx, totalPages, disableNav })
            });
        } catch (error) {
            logger.error(`[Places Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, an unexpected error occurred.`)]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Places Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
