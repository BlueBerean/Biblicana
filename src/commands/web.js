const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { setTimeout } = require('timers/promises');

const rateLimit = {
    tavily: {
        lastRequest: 0,
        minDelay: 1000  // 1 second between requests
    }
};

async function waitForRateLimit(service) {
    const now = Date.now();
    const timeSinceLastRequest = now - rateLimit[service].lastRequest;

    if (timeSinceLastRequest < rateLimit[service].minDelay) {
        const waitTime = rateLimit[service].minDelay - timeSinceLastRequest;
        await setTimeout(waitTime);
    }

    rateLimit[service].lastRequest = Date.now();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('web')
        .setDescription('(Beta) Search the web and get AI-powered answers with sources!')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to know?')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(250)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const query = interaction.options.getString('query');
            logger.info(`[Web Command] Processing query: ${query}`);

            // Check query intent using GPT before proceeding
            const intent_check = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4-turbo-preview",
                messages: [
                    {
                        role: "system",
                        content: `You are a Christian content filter focused on facilitating respectful dialogue. Your task is to determine if a question:

1. Seeks genuine understanding about:
• Christianity, biblical topics, or moral/ethical issues
• Scientific topics from a Christian perspective
• Historical or archaeological discussions related to faith
• Challenging questions about faith and science
• Honest inquiries about apparent contradictions
• Different Christian interpretations of Genesis and creation

2. Return "true" if:
• The question seeks genuine understanding
• Shows respect for faith while questioning
• Explores scientific or historical evidence
• Discusses different Christian viewpoints
• Asks about reconciling faith and science

3. Return "false" only if:
• Promotes hate or intentionally mocks faith
• Seeks validation for clearly unethical activities
• Shows clear hostile intent towards Christianity
• Uses deliberately inflammatory language

Err on the side of "true" for sincere questions, even if challenging.`
                    },
                    {
                        role: "user",
                        content: query
                    }
                ],
                max_tokens: 10,
                temperature: 0.1
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const shouldAnswer = intent_check.data.choices[0].message.content.toLowerCase().includes('true');

            if (!shouldAnswer) {
                return interaction.editReply({
                    content: 'I can only answer questions that align with Christian teachings and biblical wisdom. Please rephrase your question or ask something else.',
                    ephemeral: true
                });
            }

            // Get search results and content from Tavily
            await waitForRateLimit('tavily');
            let tavily_response;
            try {
                tavily_response = await axios.post('https://api.tavily.com/search', {
                    query: query + " Christian perspective biblical teaching",
                    search_depth: "advanced",
                    include_images: false,
                    max_results: 5,
                    include_answer: true,
                    include_content: true,
                    content_length: 2000
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
                    }
                });

                // Filter out PDF results
                if (tavily_response.data.results) {
                    tavily_response.data.results = tavily_response.data.results.filter(result => {
                        const isPDF = result.url.toLowerCase().endsWith('.pdf') || 
                                    result.title.toLowerCase().includes('pdf') ||
                                    result.content.includes('PDF-') ||
                                    result.content.includes('%PDF');
                        
                        if (isPDF) {
                            logger.info(`[Web Command] Skipping PDF source: ${result.title} - ${result.url}`);
                        }
                        return !isPDF;
                    });
                }

                if (!tavily_response.data.results || tavily_response.data.results.length === 0) {
                    return interaction.editReply('I couldn\'t find any relevant web results for your query.');
                }

                const results = tavily_response.data.results;
                logger.info(`[Web Command] Tavily found ${results.length} results`);

                // Log detailed information about each result
                results.forEach((result, index) => {
                    logger.info(`\n=== Source ${index + 1} ===`);
                    logger.info(`Title: ${result.title}`);
                    logger.info(`URL: ${result.url}`);
                    logger.info(`Content Preview: ${result.content.substring(0, 500)}...\n`);
                });

                // Prepare content for GPT with full text
                const sourcesForGPT = results.map((result, index) => {
                    const fullContent = result.content || result.raw_content || result.snippet || '';
                    return `Source ${index + 1}: ${result.title}\nURL: ${result.url}\nContent: ${fullContent}`;
                }).join('\n\n');

                logger.info('[Web Command] Content length being sent to GPT:', sourcesForGPT.length);
                logger.info('[Web Command] First 1000 characters of content:');
                logger.info(sourcesForGPT.substring(0, 1000));

                // Get GPT to analyze and summarize the results with improved prompt
                const gpt_response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: "gpt-4-turbo-preview",
                    messages: [
                        {
                            role: "system",
                            content: `You are a concise Christian apologetics research assistant. Please provide factual, evidence-based information from a Protestant Christian perspective.

Important Doctrinal Guidelines:
• For denominational topics:
    - In the introduction and conclusion, emphasize that salvation is through Christ alone (John 14:6)
    - Point to Scripture as the ultimate authority
    - Avoid promoting non-biblical traditions
    - When discussing non-Protestant views, respectfully redirect to biblical sources
    - Remind that unity in Christ is important while maintaining biblical truth

Important Guidelines:
• Length: 
    - Total response must be under 300 words
    - Reserve last 50 words for conclusion
    - Use short, clear sentences
    - Count your words carefully
• Formatting:
    - Only use a ### title at the top (the question being answered) and a ## title for the entire response
    - Do not use section headers like "Introduction," "Main Content," or "Conclusion"
    - Use bullet points sparingly
    - No extra spacing

Content Structure (these are internal guidelines, do not show these as headers):
• First 50 words:
    - Briefly state the question
    - Preview main points
• Next 200 words:
    - Present key evidence and facts
    - Use citations (Source X)
• Final 50 words:
    - Summarize key points
    - State implications
    - Must end with a complete sentence and proper punctuation
    - Never end mid-sentence or without a period

Requirements:
• Always cite sources using (Source X)
• Ensure conclusion ends with proper punctuation
• Keep paragraphs short and focused
• Only referenced sources will be listed at the end
• Do not label sections with headers
• For denominational questions, emphasize biblical authority and salvation through Christ alone`
                        },
                        {
                            role: "user",
                            content: `Provide a compact, evidence-focused answer about: ${query}

Structure your response in exactly 300 words:
- 50 words introduction
- 200 words main content
- 50 words conclusion

Focus on:
• Historical evidence and dates
• Archaeological findings
• Biblical references
• Specific names and places
• Verifiable facts

Sources:
${sourcesForGPT}`
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.7
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                        'Content-Type': 'application/json'
                    }
                });

                let answer = gpt_response.data.choices[0].message.content;

                // Add detailed logging
                logger.info('\n=== GPT Response Details ===');
                logger.info(`Response length: ${answer.length} characters`);
                logger.info(`Tokens used: ${gpt_response.data.usage.total_tokens}`);
                logger.info(`Tokens remaining: ${4096 - gpt_response.data.usage.total_tokens}`);
                logger.info('\n=== Full GPT Response ===');
                logger.info(answer);

                // Add source replacement logging
                logger.info('\n=== Source Replacement Process ===');
                results.forEach((result, index) => {
                    const sourceNum = index + 1;
                    const regex = new RegExp(`\\(Source ${sourceNum}\\)`, 'g');
                    const matchCount = (answer.match(regex) || []).length;
                    logger.info(`Source ${sourceNum}: Found ${matchCount} references`);
                });

                // Replace source citations with hyperlinks
                results.forEach((result, index) => {
                    const sourceNum = index + 1;
                    // Handle both single and multiple source citations
                    const singleRegex = new RegExp(`\\(Source ${sourceNum}\\)`, 'g');
                    const multiRegex = new RegExp(`Source ${sourceNum}(?=[,\\s]*\\d*\\))`, 'g');
                    
                    // Replace single source citations
                    answer = answer.replace(singleRegex, `[(${sourceNum})](${result.url})`);
                    
                    // Replace sources in multiple citations
                    answer = answer.replace(multiRegex, `[(${sourceNum})](${result.url})`);
                });

                // Clean up the formatting of multiple citations
                answer = answer.replace(/\(Sources?\s*/, '(');
                answer = answer.replace(/,\s*\[/g, ') [');
                answer = answer.replace(/\s+\[/g, ' [');

                // Log answer length before adding sources
                logger.info('\n=== Pre-Sources Answer Length ===');
                logger.info(`Answer length before adding sources: ${answer.length} characters`);

                // Modify sources list addition to only include referenced sources
                logger.info('\n=== Adding Sources List ===');
                const usedSources = new Set();
                results.forEach((result, index) => {
                    const sourceNum = index + 1;
                    const regex = new RegExp(`\\[(${sourceNum})\\]`, 'g');
                    if (answer.match(regex)) {
                        usedSources.add(sourceNum);
                        logger.info(`Source ${sourceNum} was used in the answer`);
                    }
                });

                if (usedSources.size > 0) {
                    answer += "\n\n**Sources:**\n";
                    results.forEach((result, index) => {
                        const sourceNum = index + 1;
                        if (usedSources.has(sourceNum)) {
                            answer += `${sourceNum}. [${result.title}](${result.url})\n`;
                        }
                    });
                }

                // Log final answer length
                logger.info('\n=== Final Answer Details ===');
                logger.info(`Final answer length: ${answer.length} characters`);
                logger.info('\n=== Final Answer Content ===');
                logger.info(answer);

                // Check Discord embed limits
                const DISCORD_EMBED_LIMIT = 4096;
                if (answer.length > DISCORD_EMBED_LIMIT) {
                    logger.warn(`Answer exceeds Discord embed limit by ${answer.length - DISCORD_EMBED_LIMIT} characters`);
                    // Truncate answer if needed
                    answer = answer.substring(0, DISCORD_EMBED_LIMIT - 200) + "\n\n*[Response truncated due to length]*";
                }

                // Create embed with answer and sources
                const embed = new EmbedBuilder()
                    .setTitle(`Web Search: ${query}`)
                    .setDescription(answer)
                    .setColor(eval(process.env.EMBEDCOLOR))
                    .setFooter({
                        text: process.env.EMBEDFOOTERTEXT,
                        iconURL: process.env.EMBEDICONURL
                    });

                // Log embed details
                logger.info('\n=== Embed Details ===');
                logger.info(`Embed title length: ${embed.data.title.length}`);
                logger.info(`Embed description length: ${embed.data.description.length}`);

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                if (error.response?.status === 429) {
                    logger.warn('[Web Command] Tavily rate limit hit, waiting 5 seconds...');
                    await setTimeout(5000);
                    // Retry the request
                    tavily_response = await axios.post('https://api.tavily.com/search', /* same options */);
                } else {
                    throw error;
                }
            }

        } catch (error) {
            logger.error(`[Web Command] Error processing request: ${error.message}`);
            return interaction.editReply({
                content: 'Sorry, there was an error processing your request.',
                ephemeral: true
            });
        }
    },
}; 