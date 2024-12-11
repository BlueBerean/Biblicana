const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { bibleWrapper } = require('../utils/bibleHelper');
require('dotenv').config();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('topicalindex')
        .setDescription('Search the Bible by topic')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic to search for')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('showall')
                .setDescription('Show all available topics')
                .setRequired(false)),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            const topic = interaction.options.getString('topic')?.toLowerCase();
            const showAll = interaction.options.getBoolean('showall');

            // If no topic and not showing all, show error
            if (!topic && !showAll) {
                return interaction.editReply({
                    content: 'Please provide a topic to search for, or use the "showall" option to see all available topics.',
                    ephemeral: true
                });
            }

            // If showing all topics
            if (showAll) {
                const options = {
                    method: 'GET',
                    url: 'https://iq-bible.p.rapidapi.com/GetTopics',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPIKEY,
                        'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                    }
                };

                const response = await axios.request(options);
                logger.info('[TopicalIndex Command] All topics response:', response.data);

                const embed = new EmbedBuilder()
                    .setTitle('Available Bible Topics')
                    .setDescription(response.data.join(', '))
                    .setColor(eval(process.env.EMBEDCOLOR))
                    .setURL(process.env.WEBSITE)
                    .setFooter({ 
                        text: process.env.EMBEDFOOTERTEXT, 
                        iconURL: process.env.EMBEDICONURL 
                    });

                return interaction.editReply({ embeds: [embed] });
            }

            // Get topic info and verse count in parallel
            const [topicResponse, countResponse] = await Promise.all([
                axios.request({
                    method: 'GET',
                    url: 'https://iq-bible.p.rapidapi.com/GetTopic',
                    params: { topic },
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPIKEY,
                        'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                    }
                }),
                axios.request({
                    method: 'GET',
                    url: 'https://iq-bible.p.rapidapi.com/GetTopicVerseCount',
                    params: { topic },
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPIKEY,
                        'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                    }
                })
            ]);

            // Add null check after the API calls
            if (!topicResponse.data || !countResponse.data) {
                return interaction.editReply({
                    content: `❌ Topic "${topic}" not found. Use \`/topicalindex showall:true\` to see all available topics.`,
                    ephemeral: true
                });
            }

            logger.info('[TopicalIndex Command] Topic response:', topicResponse.data);
            logger.info('[TopicalIndex Command] Verse count response:', countResponse.data);

            // Get all verses from database in parallel
            const verses = await Promise.all(
                topicResponse.data.map(async verse => {
                    const verseId = verse.verseIds[0]; // Take first verse if multiple
                    const bookId = parseInt(verseId.substring(0, 2));
                    const chapter = parseInt(verseId.substring(2, 5));
                    const verseNum = parseInt(verseId.substring(5));

                    // Handle verse ranges
                    if (verse.verseIds.length > 1) {
                        const lastVerseId = verse.verseIds[verse.verseIds.length - 1];
                        const lastVerseNum = parseInt(lastVerseId.substring(5));
                        const verses = await bibleWrapper.getVerses(bookId, chapter, verseNum, lastVerseNum);
                        const verseText = verses.map(v => v.BSB).join(' ');
                        // Truncate long verses
                        const truncatedText = verseText.length > 500 ? verseText.substring(0, 497) + '...' : verseText;
                        return `• ${verse.citation}: ${truncatedText || 'Text not available'}`;
                    } else {
                        // Single verse
                        const verses = await bibleWrapper.getVerses(bookId, chapter, verseNum, verseNum);
                        const verseText = verses[0]?.BSB;
                        // Truncate long verses
                        const truncatedText = verseText && verseText.length > 500 ? verseText.substring(0, 497) + '...' : verseText;
                        return `• ${verse.citation}: ${truncatedText || 'Text not available'}`;
                    }
                })
            );

            // Split verses into chunks, ensuring each chunk is under 4000 characters
            const chunks = [];
            let currentChunk = [];
            let currentLength = 0;

            for (const verse of verses) {
                // If current chunk is full or adding this verse would exceed character limit
                if (currentChunk.length >= 10 || currentLength + verse.length > 3900) {
                    if (currentChunk.length > 0) {
                        chunks.push(currentChunk.join('\n\n'));
                    }
                    currentChunk = [verse];
                    currentLength = verse.length;
                } else {
                    currentChunk.push(verse);
                    currentLength += verse.length + 2; // +2 for the newlines
                }
            }

            // Don't forget the last chunk
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.join('\n\n'));
            }

            logger.info(`[TopicalIndex Command] Created ${chunks.length} pages for ${verses.length} verses`);

            // Verify we're not losing any verses
            const totalVersesInChunks = chunks.reduce((count, chunk) => 
                count + (chunk.match(/•/g) || []).length, 0
            );
            
            if (totalVersesInChunks !== verses.length) {
                logger.warn(`[TopicalIndex Command] Verse count mismatch! Expected ${verses.length} but got ${totalVersesInChunks}`);
            }

            // Create the first embed
            const embed = new EmbedBuilder()
                .setColor(eval(process.env.EMBEDCOLOR))
                .setTitle(`📖 Bible Verses about "${topic}"`)
                .setDescription(chunks[0] || 'No verses found for this topic.')
                .addFields([{ 
                    name: 'Number of Related Verses', 
                    value: countResponse.data.toString() || '0',
                    inline: true
                }])
                .setFooter({
                    text: `${process.env.EMBEDFOOTERTEXT} | Translation: BSB | Page 1/${chunks.length}`,
                    iconURL: process.env.EMBEDICONURL
                });

            // If there's only one chunk, just send it
            if (chunks.length === 1) {
                await interaction.editReply({ embeds: [embed] });
                return;
            }

            // If there are multiple chunks, add navigation buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setLabel('Previous')
                        .setEmoji("◀️")
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setLabel('Next')
                        .setEmoji("▶️")
                        .setStyle(ButtonStyle.Secondary)
                );

            const response = await interaction.editReply({
                embeds: [embed],
                components: [row]
            });

            const collector = response.createMessageComponentCollector({ 
                componentType: ComponentType.Button, 
                time: 1_800_000  // 30 minutes
            });

            let currentPage = 0;

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({ content: 'You cannot use this button 💔', ephemeral: true });
                }

                const selection = i.customId;

                currentPage = (selection === "page_back") 
                    ? (currentPage === 0 ? chunks.length - 1 : currentPage - 1)
                    : (currentPage === chunks.length - 1 ? 0 : currentPage + 1);

                // Update buttons
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('page_back')
                            .setLabel('Previous')
                            .setEmoji("◀️")
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(false),
                        new ButtonBuilder()
                            .setCustomId('page_next')
                            .setLabel('Next')
                            .setEmoji("▶️")
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(false)
                    );

                // Update embed
                const embed = new EmbedBuilder()
                    .setColor(eval(process.env.EMBEDCOLOR))
                    .setTitle(`📖 Bible Verses about "${topic}"`)
                    .setDescription(chunks[currentPage])
                    .addFields([{ 
                        name: 'Number of Related Verses', 
                        value: countResponse.data.toString() || '0',
                        inline: true
                    }])
                    .setFooter({
                        text: `${process.env.EMBEDFOOTERTEXT} | Translation: BSB | Page ${currentPage + 1}/${chunks.length}`,
                        iconURL: process.env.EMBEDICONURL
                    });

                await i.update({ embeds: [embed], components: [row] });
            });

            collector.on('end', () => {
                interaction.editReply({
                    components: []
                }).catch(() => {});
            });

        } catch (error) {
            logger.error('[TopicalIndex Command] Error:', error);
            
            if (error.response?.status === 404) {
                return interaction.editReply({
                    content: 'No information found for this topic. Try using /topicalindex showall:true to see available topics.',
                    ephemeral: true
                });
            }

            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 