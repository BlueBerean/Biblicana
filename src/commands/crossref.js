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
import { getBookId, bibleWrapper, numbersToBook, coerceTranslation } from '../utils/bibleHelper.js';
import { crossRefWrapper } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

const REFS_PER_PAGE = 8;
const MAX_FETCH = 80; // cap on total refs we'll fetch text for

function formatRefRange(book, chapter, startVerse, endVerse) {
    if (endVerse && endVerse > startVerse) {
        return `${book} ${chapter}:${startVerse}-${endVerse}`;
    }
    return `${book} ${chapter}:${startVerse}`;
}

function buildCrossrefPage({ data, pageIdx, totalPages, disableNav = false }) {
    const start = pageIdx * REFS_PER_PAGE;
    const end = Math.min(start + REFS_PER_PAGE, data.refs.length);
    const pageRefs = data.refs.slice(start, end);

    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔗 Cross References — ${data.sourceLabel}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${data.translation.toUpperCase()}:** ${data.sourceText}`));

    const components = [container];

    pageRefs.forEach((ref, localIdx) => {
        const globalIdx = start + localIdx;
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${ref.label}** — ${ref.text}`))
            .setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`openverse:bible:${ref.bookId}:${ref.chapter}:${ref.startVerse}:${ref.endVerse}:${globalIdx}`)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        components.push(section);
    });

    const totalRefs = data.totalRefCount ?? data.refs.length;
    const shownSuffix = totalRefs > data.refs.length ? ` | ${data.refs.length} of ${totalRefs} shown` : '';
    components.push(new TextDisplayBuilder().setContent(
        footerLine(`Translation: ${data.translation.toUpperCase()}${shownSuffix}`)
    ));

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('crossref')
        .setDescription('Find cross-references for a Bible verse (Treasury of Scripture Knowledge)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book of the Bible')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Bible translation to use (defaults to your saved preference or BSB)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        const rawBook = interaction.options.getString('book');
        const chapterInput = interaction.options.getString('chapter');
        const verseInput = interaction.options.getNumber('verse');

        const chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Please provide a valid chapter number.', flags: MessageFlags.Ephemeral });
        }
        if (verseInput === null || !Number.isInteger(verseInput) || verseInput < 1) {
            return interaction.reply({ content: 'Please provide a valid verse number.', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = bookId ? numbersToBook.get(bookId) : null;
        if (!bookId || !bookName) {
            return interaction.reply({ content: `I couldn't find the book "${rawBook}".`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Crossref Command] Failed to get user preference: ${dbError}`);
            }
            translation = coerceTranslation(
                interaction.options.getString('translation') || translation
            );

            logger.info(`[Crossref Command] Looking up ${bookName} ${chapter}:${verseInput} (${translation})`);

            const [crossRefResult, sourceResult] = await Promise.allSettled([
                crossRefWrapper.getForVerse(bookName, chapter, verseInput),
                bibleWrapper.getVerses(bookId, chapter, verseInput, verseInput)
            ]);

            if (sourceResult.status === 'rejected' || !sourceResult.value || sourceResult.value.length === 0 || !sourceResult.value[0][translation]) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't fetch text for ${bookName} ${chapter}:${verseInput} in ${translation.toUpperCase()}.`
                    )]
                });
            }
            const sourceText = sourceResult.value[0][translation];
            const sourceLabel = `${bookName} ${chapter}:${verseInput}`;

            if (crossRefResult.status === 'rejected' || !crossRefResult.value || crossRefResult.value.length === 0) {
                logger.warn(`[Crossref Command] No cross-references for ${bookName} ${chapter}:${verseInput}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(accentColor())
                            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔗 Cross References — ${sourceLabel}`))
                            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${translation.toUpperCase()}:** ${sourceText}`))
                            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`\n*No cross-references found for this verse.*`))
                    ]
                });
            }

            const rawRefs = crossRefResult.value;
            const totalRefCount = rawRefs.length;
            const fetchable = rawRefs.slice(0, MAX_FETCH);

            const refs = (await Promise.allSettled(fetchable.map(async ref => {
                const refBookId = getBookId(ref.target_book);
                const refBookName = refBookId ? numbersToBook.get(refBookId) : null;
                if (!refBookId || !refBookName) return null;
                const endVerse = ref.target_verse_end || ref.target_verse_start;
                const data = await bibleWrapper.getVerses(refBookId, ref.target_chapter, ref.target_verse_start, endVerse);
                if (!data || data.length === 0) return null;
                const text = data.map(v => v[translation] || v.BSB).filter(Boolean).join(' ');
                if (!text) return null;
                return {
                    label: formatRefRange(refBookName, ref.target_chapter, ref.target_verse_start, endVerse),
                    text: text.length > 300 ? text.substring(0, 299) + '…' : text,
                    bookId: refBookId,
                    chapter: ref.target_chapter,
                    startVerse: ref.target_verse_start,
                    endVerse
                };
            })))
                .filter(r => r.status === 'fulfilled' && r.value)
                .map(r => r.value);

            if (refs.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `Cross-references found for ${sourceLabel} but couldn't retrieve verse text in ${translation.toUpperCase()}.`
                    )]
                });
            }

            const data = { sourceLabel, sourceText, translation, refs, totalRefCount };
            const totalPages = Math.ceil(refs.length / REFS_PER_PAGE);

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildCrossrefPage({ data, pageIdx: 0, totalPages })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Crossref Command]',
                render: (pageIdx, { disableNav }) =>
                    buildCrossrefPage({ data, pageIdx, totalPages, disableNav })
            });
        } catch (error) {
            logger.error(`[Crossref Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An error occurred processing your cross-reference request.`)]
                });
            } catch (replyError) {
                logger.error(`[Crossref Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
