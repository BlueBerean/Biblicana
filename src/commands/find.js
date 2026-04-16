import { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import axios from 'axios';
import swearWordFilter from '../utils/filter.js';
import { numbersToBook, bibleWrapper, bookAbbreviations } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';

const MAX_VERSES_PER_PAGE = 2;
const MAX_EMBED_CHARS = 1900;
const PAGINATION_TIMEOUT_MS = 900000;
const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_MAX_TOKENS = 500;
const OPENAI_TEMPERATURE = 0.7;

function generateFooter(translation = "BSB", page, maxPages = 2) {
    return { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, iconURL: process.env.EMBEDICONURL };
}

function joinPage(page, maxChars) {
    return page.join("\n").slice(0, maxChars);
}

async function fetchAndParseVerseReferences(topic) {
    const prompt = `You are a Bible verse finder. Please find5 to 10 relevant verses about "${topic}" and respond ONLY with a JSON array in this exact format: [{"book": "abbreviated_name", "chapter": "chapter_number", "startVerse": "verse_number", "endVerse": "verse_number"}]. Use only these abbreviated names: gen, exo, lev, num, deu, jos, jdg, rut, 1sa, 2sa, 1ki, 2ki, 1ch, 2ch, ezr, neh, est, job, psa, pro, ecc, sos, isa, jer, lam, eze, dan, hos, joe, amo, oba, jon, mic, nah, hab, zep, hag, zec, mal, mat, mar, luk, joh, act, rom, 1co, 2co, gal, eph, php, col, 1th, 2th, 1ti, 2ti, tit, phm, heb, jam, 1pe, 2pe, 1jo, 2jo, 3jo, jde, rev. If no relevant verses are found, return an empty JSON array []. Do not include any text before or after the JSON array.`;

    try {
        const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            "model": OPENAI_MODEL,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": OPENAI_TEMPERATURE,
            "max_tokens": OPENAI_MAX_TOKENS
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAIKEY}`
            }
        });

        logger.info(`[Find Command] OpenAI raw response: ${JSON.stringify(apiResponse.data)}`);

        const content = apiResponse?.data?.choices?.[0]?.message?.content;
        if (!content) {
            logger.error('[Find Command] Invalid API response structure from OpenAI');
            throw new Error('Received an invalid response structure from the AI.');
        }

        let parsedVerses;
        try {
            parsedVerses = JSON.parse(content.trim());
        } catch (parseError) {
            logger.error(`[Find Command] JSON parse error: ${parseError.message}. Content: "${content}"`);
            throw new Error('Received an incorrectly formatted response from the AI.');
        }

        if (!Array.isArray(parsedVerses)) {
            logger.error(`[Find Command] Parsed response is not an array. Content: "${content}"`);
            throw new Error('Received an unexpected response format from the AI.');
        }

        for (const verse of parsedVerses) {
            if (!verse || typeof verse !== 'object' || !verse.book || !verse.chapter || !verse.startVerse) {
                logger.error(`[Find Command] Invalid verse object format in parsed response: ${JSON.stringify(verse)}`);
                throw new Error('Received improperly structured verse data from the AI.');
            }
            if (!bookAbbreviations.has(verse.book.toLowerCase())) {
                logger.warn(`[Find Command] OpenAI returned invalid book abbreviation: ${verse.book}`);
            }
        }

        logger.info(`[Find Command] Parsed verses: ${JSON.stringify(parsedVerses)}`);
        return parsedVerses;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error(`[Find Command] OpenAI API error: ${error.message}`);
            if (error.response) {
                logger.error(`[Find Command] OpenAI API error details: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
            throw new Error('Failed to communicate with the AI service.');
        }
        throw error;
    }
}

async function formatVerseDescriptions(parsedVerses, translation) {
    let description = [];
    let validVerseCount = 0;

    for (const verseRef of parsedVerses) {
        const book = verseRef.book.toLowerCase();
        const bookId = bookAbbreviations.get(book);
        const chapter = parseInt(verseRef.chapter);
        const startVerse = parseInt(verseRef.startVerse);
        const endVerse = parseInt(verseRef.endVerse) || startVerse;

        logger.info(`[Find Command] Processing verse reference - Book: ${book}, Chapter: ${chapter}, Verses: ${startVerse}-${endVerse}, BookId: ${bookId}`);

        if (!bookId || isNaN(chapter) || chapter <= 0 || isNaN(startVerse) || startVerse <= 0 || isNaN(endVerse) || endVerse < startVerse) {
            logger.warn(`[Find Command] Invalid verse data from AI - Ref: ${JSON.stringify(verseRef)}, Parsed: BookId=${bookId}, C=${chapter}, S=${startVerse}, E=${endVerse}`);
            continue;
        }

        try {
            let versesFromAPI = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);

            if (!versesFromAPI || versesFromAPI.length === 0) {
                logger.warn(`[Find Command] No verses returned from Bible API for ${book} ${chapter}:${startVerse}-${endVerse} (${translation})`);
                continue;
            }

            let verseText = versesFromAPI.map((verseData, index) => {
                const number = index + startVerse;
                const text = verseData[translation];
                if (!text) {
                    logger.warn(`[Find Command] Translation '${translation}' not found for ${book} ${chapter}:${number}. Available: ${Object.keys(verseData)}`);
                    return `[Translation ${translation} not available]`;
                }
                return (index > 0 ? ` <**${number}**> ` : "") + text;
            }).join("");

            const prettyBookName = numbersToBook.get(bookId);
            const verseRange = startVerse === endVerse ? startVerse : `${startVerse}-${endVerse}`;

            description.push(`**${prettyBookName} ${chapter}:${verseRange}**: ${verseText}\n`);
            validVerseCount++;
        } catch (bibleApiError) {
            logger.error(`[Find Command] Error fetching from Bible API for ${book} ${chapter}:${startVerse}-${endVerse}: ${bibleApiError.message}`);
            continue;
        }
    }

    return { description, validVerseCount };
}

async function sendPaginatedReply(interaction, embed, description, translation, requestedTopic) {
    let pages = [];
    let tempArr = [];
    for (const verse of description) {
        if (tempArr.length === MAX_VERSES_PER_PAGE) {
            pages.push(tempArr);
            tempArr = [];
        }
        tempArr.push(verse);
    }
    if (tempArr.length > 0) {
        pages.push(tempArr);
    }

    if (pages.length <= 1) {
        const defaultFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`, iconURL: process.env.EMBEDICONURL };
        embed.setFooter(defaultFooter).setDescription(joinPage(pages[0] || [], MAX_EMBED_CHARS));

        const disclaimerButton = new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setLabel("💡 Disclaimer")
            .setCustomId("bias_alert");
        const row = new ActionRowBuilder().addComponents(disclaimerButton);

        const replyMessage = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

        const singlePageCollector = replyMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: PAGINATION_TIMEOUT_MS
        });

        singlePageCollector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                try { await i.deferUpdate(); } catch (e) {
                    logger.warn(`[Find Command] Failed to defer user check interaction: ${e.message}`);
                }
                await i.followUp({ content: 'You cannot use this button.', flags: MessageFlags.Ephemeral });
                return;
            }
        });

        singlePageCollector.on('end', _collected => {
            logger.info(`[Find Command] Disclaimer collector ended for single-page topic "${requestedTopic}".`);
            _collected;
            interaction.editReply({ embeds: [embed], components: [] })
                .catch(editError => {
                    logger.warn(`[Find Command] Failed to remove disclaimer button after timeout: ${editError.message}`);
                });
        });

        return;
    }

    const paginationButtons = [
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setEmoji("◀️").setLabel("Previous").setCustomId("page_back"),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setEmoji("▶️").setLabel("Next").setCustomId("page_next"),
    ];
    const actionRow = new ActionRowBuilder().addComponents(...paginationButtons);
    const disclaimerButton = new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("💡 Disclaimer").setCustomId("bias_alert");
    const secondRow = new ActionRowBuilder().addComponents(disclaimerButton);

    let currentPage = 0;

    const messagePayload = {
        embeds: [embed.setFooter(generateFooter(translation, currentPage, pages.length)).setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS))],
        components: [actionRow, secondRow],
        fetchReply: true
    };

    const replyMessage = await interaction.editReply(messagePayload);

    const collector = replyMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: PAGINATION_TIMEOUT_MS
    });

    collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
            try { await i.deferUpdate(); } catch (e) {
                logger.warn(`[Find Command] Failed to defer user check interaction: ${e.message}`);
            }
            await i.followUp({ content: 'You cannot use this button.', flags: MessageFlags.Ephemeral });
            return;
        }

        try {
            await i.deferUpdate();

            if (i.customId === 'page_next') {
                currentPage = (currentPage + 1) % pages.length;
            } else if (i.customId === 'page_back') {
                currentPage = (currentPage - 1 + pages.length) % pages.length;
            }

            const updatedEmbed = EmbedBuilder.from(embed)
                .setFooter(generateFooter(translation, currentPage, pages.length))
                .setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS));

            await i.editReply({
                embeds: [updatedEmbed],
                components: [actionRow, secondRow]
            });
        } catch (updateError) {
            logger.warn(`[Find Command] Failed to update interaction after pagination: ${updateError.message} (Code: ${updateError.code})`);
        }
    });

    collector.on('end', collected => {
        logger.info(`[Find Command] Pagination collector ended for topic "${requestedTopic}". Collected ${collected.size} interactions.`);
        const finalEmbed = EmbedBuilder.from(embed)
            .setFooter(generateFooter(translation, currentPage, pages.length) + ' | Buttons inactive')
            .setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS));

        interaction.editReply({ embeds: [finalEmbed], components: [] })
            .catch(editError => {
                logger.warn(`[Find Command] Failed to edit message after collector timeout: ${editError.message}`);
            });
    });
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
        await interaction.deferReply();
        const requestedTopic = swearWordFilter(interaction.options.getString('topic'));
        logger.info(`[Find Command] User ${interaction.user.id} searching for topic: "${requestedTopic}"`);

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            logger.info(`[Find Command] Using translation: ${translation}`);

            let parsedVerses;
            try {
                parsedVerses = await fetchAndParseVerseReferences(requestedTopic);
            } catch (error) {
                logger.error(`[Find Command] Error fetching/parsing verses: ${error.message}`);
                return interaction.editReply({ content: `⚠️ Sorry, I encountered an issue while trying to understand the AI's response for "${requestedTopic}". Please try again. (${error.message})` });
            }

            if (!parsedVerses || parsedVerses.length === 0) {
                logger.info(`[Find Command] No relevant verses found by AI for topic: ${requestedTopic}`);
                return interaction.editReply({ content: `ℹ️ I couldn't find any specific verses directly related to "${requestedTopic}". Perhaps try rephrasing your topic?` });
            }

            const { description, validVerseCount } = await formatVerseDescriptions(parsedVerses, translation);

            if (validVerseCount === 0) {
                logger.warn(`[Find Command] No valid verses could be fetched or formatted for topic: ${requestedTopic}, despite AI providing references.`);
                return interaction.editReply({ content: `⚠️ Although the AI suggested some verses for "${requestedTopic}", I couldn't retrieve or format them correctly. Please try again later.` });
            }

            let embedColor = 0x0099FF;
            if (process.env.EMBEDCOLOR) {
                try {
                    embedColor = parseInt(process.env.EMBEDCOLOR.replace(/^#/, ''), 16);
                } catch (e) {
                    logger.warn(`[Find Command] Invalid EMBEDCOLOR format: ${process.env.EMBEDCOLOR}. Using default.`);
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`Verses regarding "${requestedTopic}"`)
                .setColor(embedColor)
                .setURL(process.env.WEBSITE);

            logger.debug(`Embed color being used: ${embedColor.toString(16)}`);

            await sendPaginatedReply(interaction, embed, description, translation, requestedTopic);
        } catch (error) {
            logger.error(`[Find Command] Unhandled error in execute: ${error.message}`);
            logger.error(error.stack);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ An unexpected error occurred while processing your request.', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.editReply({ content: '⚠️ An unexpected error occurred while processing your request.' });
            }
        }
    },
};
