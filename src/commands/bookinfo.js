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
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const MAX_PROSE_CHARS = 3500;
const REFS_PER_PAGE = 8;
const COLLECTOR_TIMEOUT_MS = 600_000;

// Parses "Genesis 1:1", "1 Samuel 7:12", "Psalm 22:1-5", etc.
// Returns null when unparseable so the button can be disabled.
function parseBookVerseRef(refStr) {
    if (!refStr) return null;
    const firstChunk = String(refStr).split(/[;,]/)[0].trim();
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

// Group related sections into a small number of logical pages. Each prose
// page auto-splits via splitString if it runs long. Key Verses and Cross
// References are their own clickable pages.
function buildPages(bookInfo) {
    const pages = [];

    const addProseGroup = (title, parts) => {
        const combined = parts.filter(Boolean).join('\n\n');
        if (!combined) return;
        const chunks = splitString(combined, MAX_PROSE_CHARS);
        chunks.forEach((chunk, idx) => {
            pages.push({
                type: 'prose',
                title,
                chunk,
                chunkIdx: idx,
                totalChunks: chunks.length
            });
        });
    };

    const addRefsSection = (title, refs) => {
        if (!Array.isArray(refs) || refs.length === 0) return;
        const formatted = refs
            .map(r => typeof r === 'string' ? r : (r?.reference || null))
            .filter(Boolean)
            .map(label => ({ label, parsed: parseBookVerseRef(label) }));
        if (formatted.length === 0) return;

        for (let i = 0; i < formatted.length; i += REFS_PER_PAGE) {
            const slice = formatted.slice(i, i + REFS_PER_PAGE);
            pages.push({
                type: 'refs',
                title,
                refs: slice,
                chunkIdx: Math.floor(i / REFS_PER_PAGE),
                totalChunks: Math.ceil(formatted.length / REFS_PER_PAGE)
            });
        }
    };

    const bulletList = (arr) => Array.isArray(arr) && arr.length > 0
        ? arr.map(x => `• ${x}`).join('\n')
        : null;

    // Page 1 — About: Introduction + Summary + Author/Date + Genre/Language
    const aboutParts = [];
    if (bookInfo.introduction) aboutParts.push(`**Introduction**\n${bookInfo.introduction}`);
    if (bookInfo.summary) aboutParts.push(`**Summary**\n${bookInfo.summary}`);
    if (bookInfo.author || bookInfo.date) {
        const ad = [];
        if (bookInfo.author) ad.push(`*Author:* ${bookInfo.author}`);
        if (bookInfo.date) ad.push(`*Date:* ${bookInfo.date}`);
        aboutParts.push(`**Author & Date**\n${ad.join('\n')}`);
    }
    if (bookInfo.genre || bookInfo.original_language) {
        const gl = [];
        if (bookInfo.genre) gl.push(`*Genre:* ${bookInfo.genre}`);
        if (bookInfo.original_language) {
            gl.push(`*Original Language:* ${bookInfo.original_language}${bookInfo.original_language_meaning ? ` (${bookInfo.original_language_meaning})` : ''}`);
        }
        aboutParts.push(`**Genre & Language**\n${gl.join('\n')}`);
    }
    addProseGroup('About', aboutParts);

    // Page 2 — Context: Structure + Historical Context + Purpose + Audience
    const contextParts = [];
    if (bookInfo.structure) contextParts.push(`**Structure**\n${bookInfo.structure}`);
    if (bookInfo.historical_context) contextParts.push(`**Historical Context**\n${bookInfo.historical_context}`);
    if (bookInfo.purpose) contextParts.push(`**Purpose**\n${bookInfo.purpose}`);
    if (bookInfo.audience) contextParts.push(`**Audience**\n${bookInfo.audience}`);
    addProseGroup('Context', contextParts);

    // Page 3 — Themes & People: Themes + Major Characters
    const themesParts = [];
    const themesText = bulletList(bookInfo.themes);
    if (themesText) themesParts.push(`**Themes**\n${themesText}`);
    const charactersText = bulletList(bookInfo.major_characters);
    if (charactersText) themesParts.push(`**Major Characters**\n${charactersText}`);
    addProseGroup('Themes & People', themesParts);

    // Page 4 — Key Verses (clickable)
    addRefsSection('📖 Key Verses', bookInfo.key_verses);

    // Page 5 — Cross References (clickable)
    addRefsSection('🔗 Cross References', bookInfo.cross_references);

    // Page 6 — Application: Practical Application + Connections + Theological + Symbolism
    const applicationParts = [];
    if (bookInfo.practical_application) applicationParts.push(`**Practical Application**\n${bookInfo.practical_application}`);
    if (bookInfo.connection_to_other_books) applicationParts.push(`**Connection to Other Books**\n${bookInfo.connection_to_other_books}`);
    if (bookInfo.theological_introduction) {
        applicationParts.push(`**Theological Significance**\n${bookInfo.theological_introduction.split('\n')[0]}`);
    }
    const symbolismText = bulletList(bookInfo.symbolism);
    if (symbolismText) applicationParts.push(`**Symbolism**\n${symbolismText}`);
    addProseGroup('Application & Significance', applicationParts);

    return pages;
}

function buildBookInfoPage({ bookName, pages, pageIdx, totalPages, disableNav = false }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const page = pages[pageIdx];
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    const chunkSuffix = page.totalChunks > 1 ? ` (${page.chunkIdx + 1}/${page.totalChunks})` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📖 ${bookName}${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### ${page.title}${chunkSuffix}`
        ));

    if (page.type === 'prose') {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(page.chunk));
    } else if (page.type === 'refs') {
        page.refs.forEach((entry, localIdx) => {
            const section = new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${entry.label}**`));

            if (entry.parsed) {
                const r = entry.parsed;
                const customId = `openverse:bible:${r.bookId}:${r.chapter}:${r.startVerse}:${r.endVerse}:${pageIdx}-${localIdx}`;
                section.setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(customId)
                        .setLabel('Open')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                );
            } else {
                section.setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`bookinfo:noop:${pageIdx}-${localIdx}`)
                        .setLabel('Open')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                );
            }
            container.addSectionComponents(section);
        });
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${bookName}${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`
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
        .setName('bookinfo')
        .setDescription('Get detailed information about a book of the Bible')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want to learn about')
                .setRequired(true)),

    async execute(interaction) {
        const rawBook = interaction.options.getString('book');
        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);

        if (!bookId) {
            return interaction.reply({
                content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[BookInfo Command] Looking up book: ${bookName} (ID: ${bookId})`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetBookInfo',
                params: {
                    bookId: bookId.toString().padStart(2, '0'),
                    language: 'english'
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            const bookInfo = response.data;

            if (!bookInfo) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No information found for ${bookName}.`)]
                });
            }

            const pages = buildPages(bookInfo);
            if (pages.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No detailed information available for ${bookName}.`)]
                });
            }

            const totalPages = pages.length;
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildBookInfoPage({ bookName, pages, pageIdx, totalPages })
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
                        components: buildBookInfoPage({ bookName, pages, pageIdx, totalPages })
                    });
                } catch (err) {
                    logger.error(`[BookInfo Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildBookInfoPage({ bookName, pages, pageIdx, totalPages, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[BookInfo Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[BookInfo Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, there was an error processing your request.`
                    )]
                });
            } catch (replyError) {
                logger.error(`[BookInfo Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
