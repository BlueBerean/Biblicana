const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType} = require('discord.js');
const swearWordFilter = require('../utils/filter');
const axios = require('axios');
const { numbersToBook, books, bibleWrapper } = require("../utils/bibleHelper.js");
const logger = require('../utils/logger');

const bookAbbreviations = new Map([
    ['gen', 1], ['exo', 2], ['lev', 3], ['num', 4], ['deu', 5],
    ['jos', 6], ['jdg', 7], ['rut', 8], ['1sa', 9], ['2sa', 10],
    ['1ki', 11], ['2ki', 12], ['1ch', 13], ['2ch', 14], ['ezr', 15],
    ['neh', 16], ['est', 17], ['job', 18], ['psa', 19], ['pro', 20],
    ['ecc', 21], ['sos', 22], ['isa', 23], ['jer', 24], ['lam', 25],
    ['eze', 26], ['dan', 27], ['hos', 28], ['joe', 29], ['amo', 30],
    ['oba', 31], ['jon', 32], ['mic', 33], ['nah', 34], ['hab', 35],
    ['zep', 36], ['hag', 37], ['zec', 38], ['mal', 39], ['mat', 40],
    ['mar', 41], ['luk', 42], ['joh', 43], ['act', 44], ['rom', 45],
    ['1co', 46], ['2co', 47], ['gal', 48], ['eph', 49], ['php', 50],
    ['col', 51], ['1th', 52], ['2th', 53], ['1ti', 54], ['2ti', 55],
    ['tit', 56], ['phm', 57], ['heb', 58], ['jam', 59], ['1pe', 60],
    ['2pe', 61], ['1jo', 62], ['2jo', 63], ['3jo', 64], ['jde', 65],
    ['rev', 66]
]);

function generateFooter(translation = "BSB", page, maxPages = 2) {
    return { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, iconURL: process.env.EMBEDICONURL };
}

function joinPage(page, maxChars) {
    return page.join("\n").slice(0, maxChars);
}
module.exports = {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find a specific verse related to a topic!')
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a verse for!').setRequired(true).setMinLength(3).setMaxLength(250))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use!')
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
        
        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id)
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';

            const requestedTopic = swearWordFilter(interaction.options.getString('topic'));
            logger.info(`[Find Command] Searching for topic: "${requestedTopic}"`);

            let apiResponse;
            try {
                apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                    "model": "gpt-3.5-turbo",
                    "messages": [{
                        "role": "user", 
                        "content": `You are a Bible verse finder. Please find relevant verses about "${requestedTopic}" and respond ONLY with a JSON array in this exact format: [{"book": "abbreviated_name", "chapter": "chapter_number", "startVerse": "verse_number", "endVerse": "verse_number"}]. Use only these abbreviated names: gen, exo, lev, num, deu, jos, jdg, rut, 1sa, 2sa, 1ki, 2ki, 1ch, 2ch, ezr, neh, est, job, psa, pro, ecc, sos, isa, jer, lam, eze, dan, hos, joe, amo, oba, jon, mic, nah, hab, zep, hag, zec, mal, mat, mar, luk, joh, act, rom, 1co, 2co, gal, eph, php, col, 1th, 2th, 1ti, 2ti, tit, phm, heb, jam, 1pe, 2pe, 1jo, 2jo, 3jo, jde, rev. Return 2-5 relevant verses only.`
                    }],
                    "temperature": 0.7,
                    "max_tokens": 500
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`
                    }
                });

                logger.info(`[Find Command] OpenAI raw response: ${JSON.stringify(apiResponse.data)}`);
            } catch (error) {
                logger.error(`[Find Command] OpenAI API error: ${error.message}`);
                if (error.response) {
                    logger.error(`[Find Command] OpenAI API error details: ${JSON.stringify(error.response.data)}`);
                }
                return interaction.editReply({ content: `⚠️ Sorry, I had trouble finding verses about "${requestedTopic}". Please try again.` });
            }

            if (!apiResponse?.data?.choices?.[0]?.message?.content) {
                logger.error('[Find Command] Invalid API response structure');
                return interaction.editReply({ content: `⚠️ I couldn't find any verses about ${requestedTopic}!` });
            }

            let parsedVerses;
            try {
                parsedVerses = JSON.parse(apiResponse.data.choices[0].message.content);
                logger.info(`[Find Command] Parsed verses: ${JSON.stringify(parsedVerses)}`);

                if (!Array.isArray(parsedVerses) || parsedVerses.length === 0) {
                    logger.error('[Find Command] Empty or invalid verses array');
                    return interaction.editReply({ content: `⚠️ I couldn't find any verses about ${requestedTopic}!` });
                }
            } catch (error) {
                logger.error(`[Find Command] JSON parse error: ${error.message}`);
                return interaction.editReply({ content: `⚠️ I couldn't find any verses about ${requestedTopic}!` });
            }

            let description = []
            for (const verse of parsedVerses) {
                const book = verse.book.toLowerCase();
                const bookId = bookAbbreviations.get(book);
                const chapter = verse.chapter;
                const startVerse = parseInt(verse.startVerse);
                const endVerse = parseInt(verse.endVerse) || startVerse;

                logger.info(`[Find Command] Processing verse - Book: ${book}, Chapter: ${chapter}, Verses: ${startVerse}-${endVerse}, BookId: ${bookId}`);

                if (!bookId || !chapter || !startVerse || startVerse > endVerse) {
                    logger.warn(`[Find Command] Invalid verse data - BookId: ${bookId}, Chapter: ${chapter}, Start: ${startVerse}, End: ${endVerse}`);
                    continue;
                }

                let versesFromAPI = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);
                
                if (versesFromAPI.length == 0) {
                    logger.warn(`[Find Command] No verses returned from Bible API for ${book} ${chapter}:${startVerse}-${endVerse}`);
                    continue;
                }

                let response = versesFromAPI.map((verse, index) => {
                    const number = index + startVerse;
                    return (index > 0 ? ` <**${number}**> ` : "") + verse[translation]; // If it's not the first verse, add a space before it and the number
                }).join("");

                const prettyBookName = numbersToBook.get(bookId);
                const verseRange = startVerse === endVerse ? startVerse : `${startVerse}-${endVerse}`;

                description.push(`**${prettyBookName} ${chapter}:${verseRange}**: ${response ?? "No verse found"}\n`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`Verses regarding "${requestedTopic}"`)
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE);

            logger.debug(`Embed color being used: ${process.env.EMBEDCOLOR}`);

            if (description.length == 0) {
                logger.warn(`[Find Command] No valid verses found for topic: ${requestedTopic}`);
                return interaction.editReply({ content: `⚠️ I couldn't find any verses about ${requestedTopic}!` });
            }

            const maxVerses = 2;
            const maxChars = 1900;

            let pages = [];
            let tempArr = [];
            for (const verse of description) { // When it loops through, it will use index instead of value
                if (tempArr.length === maxVerses) {
                    pages.push(tempArr);
                    tempArr = [];
                }

                tempArr.push(verse);
            }

            if (tempArr.length > 0) { // If the pages don't divide evenly, add the remaining verses to the last page
                pages.push(tempArr); 
            }

            if (pages.length > 1) {
                const paginationButtons = [
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("◀️")
                        .setLabel("Previous")
                        .setCustomId("page_back"),
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("▶️")
                        .setLabel("Next")
                        .setCustomId("page_next"),
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setLabel("💡 Disclaimer")
                        .setCustomId("bias_alert")
                ];

                const row = new ActionRowBuilder().addComponents(...paginationButtons);

                let currentPage = 0;

                const response = await interaction.editReply({
                    embeds: [embed
                        .setFooter(generateFooter(translation, currentPage, pages.length))
                        .setDescription(joinPage(pages[0], maxChars))], // Slice to maxVerses then join and slice to maxChars in case the first verse is too long
                    components: [row],
                });

                const collector = response.createMessageComponentCollector({ 
                    componentType: ComponentType.Button, 
                    time: 900000  // 15 minutes
                });

                collector.on('collect', async i => {
                    if (i.user.id !== interaction.user.id) {
                        return i.reply({ content: 'You cannot use this button!', ephemeral: true });
                    }

                    try {
                        if (i.customId === 'page_next') {
                            currentPage++;
                            if (currentPage > (pages.length - 1)) currentPage = 0;
                        } else if (i.customId === 'page_back') {
                            currentPage--;
                            if (currentPage < 0) currentPage = pages.length - 1;
                        }

                        await i.update({
                            embeds: [embed
                                .setFooter(generateFooter(translation, currentPage, pages.length))
                                .setDescription(joinPage(pages[currentPage], maxChars))
                            ],
                            components: [row]
                        });
                    } catch (error) {
                        // If interaction expired (10062) or other Discord API error, silently fail
                        if (error.code === 10062) {
                            logger.warn('[Find Command] Interaction expired');
                            return;
                        }
                        
                        // For other errors, try to notify the user
                        try {
                            await i.followUp({ 
                                content: 'Sorry, there was an error updating the message. Please try the command again.',
                                ephemeral: true 
                            });
                        } catch (e) {
                            logger.error('[Find Command] Error sending error message:', e);
                        }
                    }
                });
            } else {
                const defaultFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`, iconURL: process.env.EMBEDICONURL };
                embed.setFooter(defaultFooter).setDescription(joinPage(pages, maxChars));

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setLabel("💡 Disclaimer")
                        .setCustomId("bias_alert")
                );

                return interaction.editReply({ embeds: [embed], components: [row] });
            }
            
        } catch (error) {
            logger.error(`[Find Command] Error processing request: ${error.message}`);
            logger.error(error.stack);
            return interaction.editReply({ content: '⚠️ Sorry, there was an error processing your request.' });
        }
    },
};