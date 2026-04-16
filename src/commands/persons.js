import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { personsWrapper } from '../utils/studyHelper.js';
import { getBookId } from '../utils/bibleHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_DESC_LENGTH = 2500;
const MAX_RELATION_LIST_CHARS = 400;

// uniqueName format: "PersonName_Book.Chapter.Verse" (e.g., "Mary_Magdalene_Mat.27.56").
// Returns display name, human-readable firstRef, and structured { bookId, chapter, verse } when resolvable.
function displayName(uniqueName) {
    if (!uniqueName) return { name: 'Unknown', firstRef: '', structured: null };
    const parts = uniqueName.split('_');
    const ref = parts[parts.length - 1];
    const name = parts.slice(0, -1).join(' ');

    let structured = null;
    const refParts = ref.split('.');
    if (refParts.length === 3) {
        const bookId = getBookId(refParts[0].toLowerCase());
        const chapter = parseInt(refParts[1]);
        const verse = parseInt(refParts[2]);
        if (bookId && !isNaN(chapter) && !isNaN(verse)) {
            structured = { bookId, chapter, verse };
        }
    }

    return { name, firstRef: ref.replace(/\./g, ' '), structured };
}

function parseStrongs(uStrong) {
    if (!uStrong) return null;
    const match = uStrong.match(/^([HGhg])0*(\d+)/);
    if (!match) return null;
    const lexicon = match[1].toUpperCase() === 'G' ? 'Greek' : 'Hebrew';
    return { lexicon, strongsId: `${match[1].toUpperCase()}${match[2]}` };
}

function parseJsonArray(field) {
    if (!field) return [];
    try {
        const parsed = JSON.parse(field);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (e) { /* non-fatal */ }
    return [];
}

function formatRelation(rawField) {
    if (!rawField) return null;
    return displayName(rawField).name || null;
}

function formatRelations(jsonField) {
    const items = parseJsonArray(jsonField);
    if (items.length === 0) return null;
    const formatted = items.map(item => displayName(item).name).join(', ');
    return formatted.length > MAX_RELATION_LIST_CHARS
        ? formatted.substring(0, MAX_RELATION_LIST_CHARS - 1) + '…'
        : formatted;
}

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

function buildPersonPage({ person, pageIdx, totalPages, disableNav = false }) {
    const { name, firstRef, structured } = displayName(person.unique_name);
    const pageInfo = totalPages > 1 ? ` (Result ${pageIdx + 1}/${totalPages})` : '';

    // Facts block: tribe + sex only (first mention and Strong's get their own
    // Sections below so the affordance sits next to the info it applies to).
    const facts = [];
    if (person.tribe) facts.push(`**🏛 Tribe:** ${person.tribe}`);
    if (person.sex) facts.push(`**Sex:** ${person.sex}`);

    // Family relations
    const family = [];
    const father = formatRelation(person.father);
    const mother = formatRelation(person.mother);
    if (father) family.push(`**Father:** ${father}`);
    if (mother) family.push(`**Mother:** ${mother}`);
    const siblings = formatRelations(person.siblings);
    const partners = formatRelations(person.partners);
    const offspring = formatRelations(person.offspring);
    if (siblings) family.push(`**Siblings:** ${siblings}`);
    if (partners) family.push(`**Partners:** ${partners}`);
    if (offspring) family.push(`**Offspring:** ${offspring}`);

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 👤 ${name}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            truncate(person.ext_description || person.short_description || '*No description available.*', MAX_DESC_LENGTH)
        ));

    if (facts.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.join('\n')));
    }
    if (family.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(family.join('\n')));
    }

    // First Mention Section — info tied to its action button.
    if (structured && firstRef) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📖 First Mention:** ${firstRef}`))
                .setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`openverse:bible:${structured.bookId}:${structured.chapter}:${structured.verse}`)
                        .setLabel('Open passage')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                )
        );
    }

    // Strong's Section — info tied to its action button.
    const strongs = parseStrongs(person.uStrong);
    if (strongs) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📚 Strong's:** ${person.uStrong}`))
                .setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`strongs:${strongs.lexicon}:${strongs.strongsId}`)
                        .setLabel('Define')
                        .setEmoji({ name: '📚' })
                        .setStyle(ButtonStyle.Secondary)
                )
        );
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(totalPages > 1 ? `Result ${pageIdx + 1}/${totalPages}` : '')
    ));

    const components = [container];

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('persons')
        .setDescription('Look up a biblical figure (Aaron, David, Mary, etc.)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the person (e.g., Aaron, David, Mary Magdalene)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawName = swearWordFilter(interaction.options.getString('name').trim());
        if (!rawName) {
            return interaction.reply({ content: 'Please provide a valid name.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Persons Command] Search: "${rawName}"`);
            const results = await personsWrapper.search(rawName);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No biblical figure found matching "${rawName}". Try names like Aaron, Abraham, David, Mary, Peter.`
                    )]
                });
            }

            logger.info(`[Persons Command] Found ${results.length} match(es)`);

            const totalPages = results.length;
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPersonPage({ person: results[0], pageIdx: 0, totalPages })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Persons Command]',
                render: (pageIdx, { disableNav }) =>
                    buildPersonPage({ person: results[pageIdx], pageIdx, totalPages, disableNav })
            });
        } catch (error) {
            logger.error(`[Persons Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, an unexpected error occurred.`)]
                });
            } catch (replyError) {
                logger.error(`[Persons Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
