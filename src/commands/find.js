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
import swearWordFilter from '../utils/filter.js';
import { numbersToBook, bibleWrapper, bookAbbreviations } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';

const VERSES_PER_PAGE = 5;
const PAGINATION_TIMEOUT_MS = 900_000;
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_MAX_TOKENS = 500;
const OPENAI_TEMPERATURE = 0.7;
const VERSE_TEXT_TRUNCATE = 300;

async function fetchAndParseVerseReferences(topic) {
    const prompt = `You are a Bible verse finder. Please find5 to 10 relevant verses about "${topic}" and respond ONLY with a JSON array in this exact format: [{"book": "abbreviated_name", "chapter": "chapter_number", "startVerse": "verse_number", "endVerse": "verse_number"}]. Use only these abbreviated names: gen, exo, lev, num, deu, jos, jdg, rut, 1sa, 2sa, 1ki, 2ki, 1ch, 2ch, ezr, neh, est, job, psa, pro, ecc, sos, isa, jer, lam, eze, dan, hos, joe, amo, oba, jon, mic, nah, hab, zep, hag, zec, mal, mat, mar, luk, joh, act, rom, 1co, 2co, gal, eph, php, col, 1th, 2th, 1ti, 2ti, tit, phm, heb, jam, 1pe, 2pe, 1jo, 2jo, 3jo, jde, rev. If no relevant verses are found, return an empty JSON array []. Do not include any text before or after the JSON array.`;

    const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: OPENAI_TEMPERATURE,
        max_tokens: OPENAI_MAX_TOKENS
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAIKEY}`
        }
    });

    const content = apiResponse?.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Received an invalid response structure from the AI.');

    const parsed = JSON.parse(content.trim());
    if (!Array.isArray(parsed)) throw new Error('AI response was not an array.');
    return parsed;
}

async function resolveVerses(parsedVerses, translation) {
    const resolved = [];
    for (const ref of parsedVerses) {
        const book = ref.book?.toLowerCase();
        const bookId = bookAbbreviations.get(book);
        const chapter = parseInt(ref.chapter);
        const startVerse = parseInt(ref.startVerse);
        const endVerse = parseInt(ref.endVerse) || startVerse;

        if (!bookId || isNaN(chapter) || chapter <= 0 || isNaN(startVerse) || startVerse <= 0 || isNaN(endVerse) || endVerse < startVerse) {
            logger.warn(`[Find Command] Invalid AI ref: ${JSON.stringify(ref)}`);
            continue;
        }

        try {
            const data = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);
            if (!data || data.length === 0) continue;

            const text = data.map((v, idx) => {
                const num = idx + startVerse;
                const t = v[translation];
                if (!t) return `[${translation} unavailable]`;
                return (idx > 0 ? ` **${num}** ` : '') + t;
            }).join('');

            if (!text) continue;

            const bookName = numbersToBook.get(bookId);
            const rangeLabel = endVerse !== startVerse
                ? `${bookName} ${chapter}:${startVerse}-${endVerse}`
                : `${bookName} ${chapter}:${startVerse}`;
            const truncatedText = text.length > VERSE_TEXT_TRUNCATE
                ? text.substring(0, VERSE_TEXT_TRUNCATE - 1) + '…'
                : text;

            resolved.push({
                bookId, bookName, chapter, startVerse, endVerse,
                rangeLabel,
                text: truncatedText
            });
        } catch (err) {
            logger.error(`[Find Command] Error fetching ${book} ${chapter}:${startVerse}-${endVerse}: ${err.message}`);
        }
    }
    return resolved;
}

function buildFindPage({ verses, pageIdx, totalPages, topic, translation, disableNav = false }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const start = pageIdx * VERSES_PER_PAGE;
    const end = Math.min(start + VERSES_PER_PAGE, verses.length);
    const pageVerses = verses.slice(start, end);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔍 Verses about "${topic}"${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`*AI-suggested passages. Tap Open on any verse for full exploration.*`));

    const components = [container];

    for (const v of pageVerses) {
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${v.rangeLabel}** — ${v.text}`))
            .setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`openverse:bible:${v.bookId}:${v.chapter}:${v.startVerse}`)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        components.push(section);
    }

    components.push(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | Translation: ${translation.toUpperCase()}`
    ));

    // Bottom row: pagination (if multi-page) + AI disclaimer button.
    // The disclaimer button (customId 'bias_alert') is handled globally by
    // src/components/buttons/bias.js — no local collector needed for it.
    const rowButtons = [];
    if (totalPages > 1) {
        rowButtons.push(
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
    }
    rowButtons.push(
        new ButtonBuilder()
            .setCustomId('bias_alert')
            .setEmoji({ name: '💡' })
            .setLabel('Disclaimer')
            .setStyle(ButtonStyle.Secondary)
    );
    components.push(new ActionRowBuilder().addComponents(...rowButtons));

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find a specific verse related to a topic')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a verse for').setRequired(true).setMinLength(3).setMaxLength(250))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
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
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const topic = swearWordFilter(interaction.options.getString('topic'));
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            logger.info(`[Find Command] User ${interaction.user.id} topic: "${topic}" (${translation})`);

            let parsedVerses;
            try {
                parsedVerses = await fetchAndParseVerseReferences(topic);
            } catch (err) {
                logger.error(`[Find Command] AI fetch error: ${err.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ Couldn't process AI response for "${topic}". ${err.message}`
                    )]
                });
            }

            if (!parsedVerses || parsedVerses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `ℹ️ I couldn't find any specific verses directly related to "${topic}". Try rephrasing.`
                    )]
                });
            }

            const verses = await resolveVerses(parsedVerses, translation);
            if (verses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ The AI suggested verses for "${topic}" but I couldn't retrieve text for any of them.`
                    )]
                });
            }

            const totalPages = Math.ceil(verses.length / VERSES_PER_PAGE);
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildFindPage({ verses, pageIdx, totalPages, topic, translation })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: PAGINATION_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
                    else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
                    await i.editReply({
                        flags,
                        components: buildFindPage({ verses, pageIdx, totalPages, topic, translation })
                    });
                } catch (err) {
                    logger.error(`[Find Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildFindPage({ verses, pageIdx, totalPages, topic, translation, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Find Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Find Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ An unexpected error occurred while processing your request.`
                    )]
                });
            } catch (replyError) {
                logger.error(`[Find Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
