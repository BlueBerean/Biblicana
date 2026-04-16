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
import { placesWrapper } from '../utils/studyHelper.js';
import { getBookId } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;
const MAX_DESC_LENGTH = 3000;

// uniqueName format: "PlaceName_Book.Chapter.Verse" (e.g., "Akeldama_Mat.27.7").
// Returns display name, human-readable first-ref string, and a structured
// { bookId, chapter, verse } when the ref is resolvable to an openverse target.
function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '', structured: null };
    const parts = uniqueName.split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');

    let structured = null;
    const refParts = ref.split('.');
    if (refParts.length === 3) {
        const [bookCode, chapterStr, verseStr] = refParts;
        const bookId = getBookId(bookCode.toLowerCase());
        const chapter = parseInt(chapterStr);
        const verse = parseInt(verseStr);
        if (bookId && !isNaN(chapter) && !isNaN(verse)) {
            structured = { bookId, chapter, verse };
        }
    }

    return { name, firstRef: ref.replace(/\./g, ' '), structured };
}

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
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const { name, firstRef, structured } = displayName(place.unique_name);
    const displayTitle = place.openbible_name || name;
    const pageInfo = totalPages > 1 ? ` (Result ${pageIdx + 1}/${totalPages})` : '';

    const description = truncate(place.ext_description || place.short_description || '*No description available.*', MAX_DESC_LENGTH);

    // Facts block
    const facts = [];
    if (firstRef) facts.push(`**📖 First Mention:** ${firstRef}`);
    if (place.uStrong) facts.push(`**Strong's:** ${place.uStrong}`);
    if (place.lonlat) facts.push(`**🧭 Coordinates:** ${place.lonlat}`);

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📍 ${displayTitle}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(description));

    if (facts.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.join('\n')));
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'}${totalPages > 1 ? ` | Result ${pageIdx + 1}/${totalPages}` : ''}`
    ));

    const components = [container];

    // Row 1 — in-app action buttons (Secondary style, route through existing handlers).
    const actionButtons = [];
    if (structured) {
        actionButtons.push(new ButtonBuilder()
            .setCustomId(`openverse:bible:${structured.bookId}:${structured.chapter}:${structured.verse}`)
            .setLabel('Open passage')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary));
    }
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
        const navRow = new ActionRowBuilder().addComponents(
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
        components.push(navRow);
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

            let currentPage = 0;
            const totalPages = results.length;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildPlacePage({ place: results[currentPage], pageIdx: currentPage, totalPages })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') currentPage = Math.max(0, currentPage - 1);
                    else if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                    await i.editReply({
                        flags,
                        components: buildPlacePage({ place: results[currentPage], pageIdx: currentPage, totalPages })
                    });
                } catch (err) {
                    logger.error(`[Places Command] Collector error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildPlacePage({ place: results[currentPage], pageIdx: currentPage, totalPages, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Places Command] Error disabling pagination: ${err.message}`);
                    }
                }
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
