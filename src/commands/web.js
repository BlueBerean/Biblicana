const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { setTimeout } = require('timers/promises');
require('dotenv').config(); // Added dotenv

// --- Constants ---
const INTENT_MODEL = "gpt-4o-mini";
const SUMMARY_MODEL = "gpt-4o-mini";
const INTENT_MAX_TOKENS = 10;
const INTENT_TEMPERATURE = 0.1;
const SUMMARY_MAX_TOKENS = 500; // Max tokens for the summary response
const SUMMARY_TEMPERATURE = 0.7;
const TAVILY_MAX_RESULTS = 5;
const TAVILY_RATE_LIMIT_MS = 1000; // 1 second
const TAVILY_RETRY_DELAY_MS = 5000; // 5 seconds
const TAVILY_MAX_RETRIES = 1;
const MAX_SOURCE_PREVIEW_LENGTH = 500;
const MAX_GPT_INPUT_PREVIEW_LENGTH = 1000;
const DISCORD_EMBED_LIMIT = 4096;
const TRUNCATION_SUFFIX = "\n\n*[Response truncated due to length]*";
const TRUNCATION_BUFFER = 200; // Characters to leave for suffix and formatting

// --- Rate Limiter ---
const rateLimit = {
    tavily: {
        lastRequest: 0,
        minDelay: TAVILY_RATE_LIMIT_MS
    }
};

async function waitForRateLimit(service) {
    const now = Date.now();
    const serviceLimit = rateLimit[service];
    const timeSinceLastRequest = now - serviceLimit.lastRequest;

    if (timeSinceLastRequest < serviceLimit.minDelay) {
        const waitTime = serviceLimit.minDelay - timeSinceLastRequest;
        logger.debug(`[Rate Limiter] Waiting ${waitTime}ms for ${service}`);
        await setTimeout(waitTime);
    }
    serviceLimit.lastRequest = Date.now(); // Update last request time *after* waiting
}

// --- Main Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('web')
        .setDescription('(Beta) Search the web and get AI-powered answers with sources')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to know?')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(250)), // Max length consistent with other commands

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const query = interaction.options.getString('query');
            logger.info(`[Web Command] Processing query: "${query}"`);

            // --- Intent Check ---
            // (Keeping inline for now, could be moved to helper)
            let shouldAnswer = false;
            try {
                const intent_check = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: INTENT_MODEL,
                    messages: [
                        {
                            role: "system",
                            content: `You are a Christian content filter focused on facilitating respectful dialogue. Your task is to determine if a question:
1. Seeks genuine understanding about: Christianity, biblical topics, moral/ethical issues, scientific topics from a Christian perspective, historical/archaeological discussions related to faith, challenging questions about faith/science, honest inquiries about apparent contradictions, different Christian interpretations of Genesis/creation.
2. Return "true" if: the question seeks genuine understanding, shows respect for faith while questioning, explores scientific/historical evidence, discusses different Christian viewpoints, asks about reconciling faith/science.
3. Return "false" ONLY if: promotes hate/intentionally mocks faith, seeks validation for clearly unethical activities, shows clear hostile intent towards Christianity, uses deliberately inflammatory language, tries to promote one sect or denomination as the only true one.
Err on the side of "true" for sincere questions, even if challenging. Respond ONLY with the single word "true" or the single word "false". Do not add any other text or punctuation.`
                        },
                        { role: "user", content: query }
                    ],
                    max_tokens: INTENT_MAX_TOKENS,
                    temperature: INTENT_TEMPERATURE
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                const intentResponse = intent_check.data.choices[0]?.message?.content?.trim().toLowerCase();
                 logger.info(`[Web Command] Intent check response: "${intentResponse}"`);
                shouldAnswer = intentResponse === 'true'; // Stricter check

            } catch (intentError) {
                 logger.error(`[Web Command] OpenAI intent check failed: ${intentError.message}`);
                 // Decide how to handle intent check failure - proceed cautiously or fail?
                 // For now, let's assume intent is okay if the check fails, but log a warning.
                 logger.warn(`[Web Command] Intent check failed, proceeding with caution.`);
                 shouldAnswer = true; // Defaulting to true on error
            }


            if (!shouldAnswer) {
                logger.info(`[Web Command] Query intent deemed inappropriate.`);
                return interaction.editReply({
                    content: 'I can only answer questions that align with Christian teachings and biblical wisdom. Please rephrase your question or ask something else.',
                    ephemeral: true
                });
            }

            // --- Tavily Search ---
            // (Keeping inline for now)
            let tavily_results = null;
            let retries = 0;
            while (retries <= TAVILY_MAX_RETRIES && !tavily_results) {
                 try {
                    await waitForRateLimit('tavily');
                    logger.info(`[Web Command] Calling Tavily API (Attempt ${retries + 1})`);
                    const tavily_response = await axios.post('https://api.tavily.com/search', {
                        query: query + " Christian perspective biblical teaching", // Appending context
                        search_depth: "advanced",
                        include_images: false,
                        max_results: TAVILY_MAX_RESULTS,
                        include_answer: true, // Requesting Tavily's summarized answer
                        include_raw_content: false, // Don't need raw if content is included
                        include_content: true, // Request processed content snippets
                        // content_length: TAVILY_CONTENT_LENGTH, // This param seems deprecated
                    }, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
                        },
                        timeout: 10000 // Add timeout to Tavily request (10 seconds)
                    });

                    if (!tavily_response.data) {
                        throw new Error("Tavily API returned no data.");
                    }
                    tavily_results = tavily_response.data; // Assign on success
                    logger.debug("[Web Command] Tavily Raw Response:", JSON.stringify(tavily_results));

                 } catch (tavilyError) {
                    if (axios.isAxiosError(tavilyError) && tavilyError.response?.status === 429 && retries < TAVILY_MAX_RETRIES) {
                        retries++;
                        logger.warn(`[Web Command] Tavily rate limit hit. Retrying in ${TAVILY_RETRY_DELAY_MS / 1000}s... (${retries}/${TAVILY_MAX_RETRIES})`);
                        await setTimeout(TAVILY_RETRY_DELAY_MS);
                    } else {
                         logger.error(`[Web Command] Tavily API request failed: ${tavilyError.message}`);
                         if (tavilyError.response) logger.error(`[Web Command] Tavily Error Details: Status ${tavilyError.response.status}, Data: ${JSON.stringify(tavilyError.response.data)}`);
                         // Stop retrying on other errors or max retries reached
                         throw new Error("Failed to get search results from Tavily.");
                    }
                 }
            }

            if (!tavily_results) { // Should only happen if all retries failed
                 return interaction.editReply({ content: 'Sorry, I could not retrieve search results after multiple attempts.', ephemeral: true });
            }


            // --- Process Tavily Results ---
            // Filter out PDF results and validate
            let results = tavily_results.results || [];
            results = results.filter(result => {
                if (!result || !result.url || typeof result.url !== 'string') return false; // Basic validation
                const urlLower = result.url.toLowerCase();
                const titleLower = result.title?.toLowerCase() || '';
                const contentSample = (result.content || result.raw_content || result.snippet || '').substring(0, 50); // Check start of content

                const isPDF = urlLower.endsWith('.pdf') ||
                              urlLower.includes('format=pdf') ||
                              titleLower.includes('pdf') ||
                              contentSample.includes('%PDF');

                if (isPDF) {
                    logger.info(`[Web Command] Skipping PDF source: ${result.title || 'No Title'} - ${result.url}`);
                }
                return !isPDF && result.content; // Ensure content exists
            });

            if (results.length === 0) {
                logger.info(`[Web Command] No non-PDF web results found for query.`);
                return interaction.editReply('I couldn\'t find any relevant, non-PDF web results for your query.');
            }

            logger.info(`[Web Command] Tavily found ${results.length} valid, non-PDF results`);

            // --- Prepare Source Data for GPT and Linking ---
            const sourceMap = new Map(); // Maps derived name -> { url, title }
            const sourceDataForGPT = [];

            results.forEach((result, index) => {
                let derivedName = 'Source'; // Default
                try {
                    const url = new URL(result.url);
                    // Remove www. and keep hostname
                    derivedName = url.hostname.replace(/^www\./, '');
                } catch (e) {
                    logger.warn(`[Web Command] Could not parse URL for source ${index + 1}: ${result.url}`);
                    // Use index as fallback name if URL parsing fails
                    derivedName = `Source-${index + 1}`;
                }

                // Handle potential name collisions (simple approach: append index)
                let uniqueName = derivedName;
                let collisionCounter = 2;
                while (sourceMap.has(uniqueName)) {
                    uniqueName = `${derivedName}-${collisionCounter}`;
                    collisionCounter++;
                }
                derivedName = uniqueName;

                sourceMap.set(derivedName, { url: result.url, title: result.title || derivedName });

                const fullContent = result.content || '';
                sourceDataForGPT.push(`Source ${derivedName}: ${result.title || derivedName}\nURL: ${result.url}\nContent: ${fullContent}`);

                // Log processed source info
                logger.debug(`\n=== Processed Source: ${derivedName} ===`);
                logger.debug(`Title: ${result.title || derivedName}`);
                logger.debug(`URL: ${result.url}`);
                logger.debug(`Content Preview: ${fullContent.substring(0, MAX_SOURCE_PREVIEW_LENGTH)}...\n`);
            });

            const sourcesForGPT = sourceDataForGPT.join('\n\n---\n\n'); // Use a clear separator

            logger.info(`[Web Command] Combined content length being sent to GPT: ${sourcesForGPT.length}`);
            if (sourcesForGPT.length > 0) {
                logger.debug('[Web Command] First characters of content for GPT:');
                logger.debug(sourcesForGPT.substring(0, MAX_GPT_INPUT_PREVIEW_LENGTH));
            }

            // --- Generate Summary with GPT ---
            let gptAnswer = '';
            try {
                const gpt_response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: SUMMARY_MODEL,
                    messages: [
                        {
                            role: "system",
                            content: `You are a concise Christian apologetics research assistant providing factual, evidence-based info from a Protestant perspective.
Guidelines:
- Salvation is through Christ alone (John 14:6). Scripture is the ultimate authority. Avoid non-biblical traditions. Redirect non-Protestant views respectfully to biblical sources. Emphasize unity in Christ.
- Response must be under 300 words total (strict maximum). Aim for approximately: 50 words introduction, 200 words main content, 50 words conclusion.
- Format: Start with a single '## Title Derived from User Query'. Use bullet points sparingly. No extra spacing.
- Requirements: Base your answer EXCLUSIVELY on the provided Sources. Do not add outside knowledge. If sources don't cover an aspect, state that. Cite sources using ONLY (SourceName) where SourceName is the name provided after 'Source ' in the user prompt (e.g., (christianity.com), (gotquestions.org)). Cite ALL evidence/facts. Ensure conclusion ends with proper punctuation. Keep paragraphs short. Only referenced sources will be listed. Adhere to doctrinal guidelines, especially for denominational questions.`
                        },
                        {
                            role: "user",
                            content: `Query: "${query}"

Based *only* on the provided sources below, provide a compact, evidence-focused answer (under 300 words, follow ALL system guidelines strictly).

Focus on:
• Historical evidence and dates
• Archaeological findings
• Biblical references (if applicable in sources)
• Specific names and places
• Verifiable facts

Sources:
${sourcesForGPT}`
                        }
                    ],
                    max_tokens: SUMMARY_MAX_TOKENS,
                    temperature: SUMMARY_TEMPERATURE
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000 // Timeout for summary generation (20 seconds)
                });

                gptAnswer = gpt_response.data.choices[0]?.message?.content || '';

                logger.info('\n=== GPT Response Details ===');
                logger.info(`Raw Response Length: ${gptAnswer.length} characters`);
                if(gpt_response.data.usage) {
                     logger.info(`Tokens Used: ${gpt_response.data.usage.total_tokens}`);
                 }
                 logger.debug('\n=== Full Raw GPT Response ===');
                 logger.debug(gptAnswer);

                if (!gptAnswer) {
                     throw new Error("GPT returned an empty answer.");
                }

            } catch (summaryError) {
                logger.error(`[Web Command] OpenAI summary generation failed: ${summaryError.message}`);
                 if (summaryError.response) logger.error(`[Web Command] OpenAI Error Details: Status ${summaryError.response.status}, Data: ${JSON.stringify(summaryError.response.data)}`);
                 // Fallback: Maybe provide Tavily's answer if available?
                 if (tavily_results.answer) {
                     logger.warn("[Web Command] GPT summary failed, falling back to Tavily's answer.");
                     gptAnswer = tavily_results.answer; // Use Tavily's answer as a fallback
                 } else {
                    // If no fallback, throw error
                    throw new Error("Failed to generate a summary for the search results.");
                 }
            }


            // --- Format Answer and Sources ---
            let finalAnswer = gptAnswer;
            const usedSourceNames = new Set(); // Track used source names

            // Update regex to find (SourceName)
            logger.info('\n=== Source Linking Process ===');
            finalAnswer = finalAnswer.replace(/\(([\w.-]+(?:-\d+)?)\)/g, (match, sourceName) => {
                 // Check if the captured name exists in our map
                if (sourceMap.has(sourceName)) {
                    usedSourceNames.add(sourceName);
                    const sourceInfo = sourceMap.get(sourceName);
                    logger.debug(`Linking citation (${sourceName}) to ${sourceInfo.url}`);
                    // Format as [(SourceName)](url) for visual parentheses
                    return `[(${sourceName})](${sourceInfo.url})`;
                } else {
                    logger.warn(`Found citation format "${match}" but name "${sourceName}" is not in the source map.`);
                    return match; // Return original if name not found
                }
            });

            // Build sources list using the derived names and map
            let sourcesList = "";
            if (usedSourceNames.size > 0) {
                sourcesList += "\n\n**Sources:**\n";
                // Sort names before listing? Optional.
                 Array.from(usedSourceNames).sort().forEach(name => {
                    const sourceInfo = sourceMap.get(name);
                    // Basic sanitization for title in link
                    const title = (sourceInfo.title || name).replace(/[[\]{}()]/g, '');
                    sourcesList += `• [${title}](${sourceInfo.url}) (*${name}*)\n`; // Show title and derived name
                });
            }

            logger.info('\n=== Pre-Sources Answer Length ===');
            logger.info(`Answer length before adding sources list: ${finalAnswer.length} characters`);

            finalAnswer += sourcesList; // Append the generated list

            logger.info('\n=== Final Answer Details ===');
            logger.info(`Final answer length (with sources): ${finalAnswer.length} characters`);
            logger.debug('\n=== Final Answer Content (with sources) ===');
            logger.debug(finalAnswer);

            // Check Discord embed limits and truncate if necessary
            if (finalAnswer.length > DISCORD_EMBED_LIMIT) {
                const truncateLength = DISCORD_EMBED_LIMIT - TRUNCATION_SUFFIX.length - TRUNCATION_BUFFER;
                logger.warn(`Answer exceeds Discord embed limit by ${finalAnswer.length - DISCORD_EMBED_LIMIT} characters. Truncating.`);
                finalAnswer = finalAnswer.substring(0, truncateLength) + TRUNCATION_SUFFIX;
            }

            // --- Create and Send Embed ---
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF; // Use base 16

            const embed = new EmbedBuilder()
                .setTitle(`Web Search: ${query}`) // Keep original query for title context
                .setDescription(finalAnswer)
                .setColor(embedColor)
                .setURL(process.env.WEBSITE) // Optional link
                .setFooter({
                    text: process.env.EMBEDFOOTERTEXT,
                    iconURL: process.env.EMBEDICONURL
                })
                .setTimestamp(); // Add timestamp

            logger.info('\n=== Final Embed Details ===');
            logger.info(`Embed Description Length: ${embed.data.description?.length || 0}`);

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
             // Catch errors from helpers or main logic
            logger.error(`[Web Command] Unhandled error in execute: ${error.message}`, error.stack);
            try {
                 await interaction.editReply({
                    content: `❌ Sorry, an unexpected error occurred while processing your web search: ${error.message}`,
                    ephemeral: true,
                    embeds: [], components: []
                 });
            } catch (replyError) {
                 if (replyError.code !== 10062 && replyError.code !== 40060) {
                     logger.error(`[Web Command] Failed to send final error reply: ${replyError}`);
                 }
            }
        }
    },
}; 