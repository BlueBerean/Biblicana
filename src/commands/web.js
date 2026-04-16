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
import axios from 'axios';
import { setTimeout as wait } from 'node:timers/promises';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import 'dotenv/config';

const INTENT_MODEL = 'gpt-4o-mini';
const SUMMARY_MODEL = 'gpt-4o-mini';
const INTENT_MAX_TOKENS = 10;
const INTENT_TEMPERATURE = 0.1;
const INTENT_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_TOKENS = 1500;
const SUMMARY_TEMPERATURE = 0.7;
const TAVILY_MAX_RESULTS = 5;
const TAVILY_RATE_LIMIT_MS = 1000;
const TAVILY_RETRY_DELAY_MS = 5000;
const TAVILY_MAX_RETRIES = 1;
const MAX_CHARS_PER_PAGE = 3500;
const MAX_BUTTON_LABEL = 80;
const RATE_LIMIT = { limit: 10, windowSeconds: 3600 };

const rateLimit = {
    tavily: { lastRequest: 0, minDelay: TAVILY_RATE_LIMIT_MS }
};

async function waitForRateLimit(service) {
    const now = Date.now();
    const serviceLimit = rateLimit[service];
    const timeSinceLastRequest = now - serviceLimit.lastRequest;
    if (timeSinceLastRequest < serviceLimit.minDelay) {
        const waitTime = serviceLimit.minDelay - timeSinceLastRequest;
        await wait(waitTime);
    }
    serviceLimit.lastRequest = Date.now();
}

function truncateLabel(text, max = MAX_BUTTON_LABEL) {
    if (!text) return 'Source';
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
}

function buildWebAnswerPage({ query, chunks, pageIdx, totalPages, usedSources, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    const pageSuffix = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🌐 ${truncateLabel(query, 180)}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunks[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`AI-assisted answer from web sources${pageSuffix}`)
        ));

    const components = [container];

    // Sources become link buttons (max 5 per row, Tavily caps at 5 results).
    if (usedSources.length > 0) {
        const linkRow = new ActionRowBuilder().addComponents(
            ...usedSources.slice(0, 5).map(({ name, info }) => {
                const label = truncateLabel(info.title || name, 35);
                return new ButtonBuilder()
                    .setLabel(label)
                    .setStyle(ButtonStyle.Link)
                    .setURL(info.url);
            })
        );
        components.push(linkRow);
    }

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('web')
        .setDescription('(Beta) Search the web and get AI-powered answers with sources')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to know?')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(250)),

    async execute(interaction, database) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const rl = await database.checkRateLimit('web', interaction.user.id, RATE_LIMIT);
            if (!rl.allowed) {
                const mins = Math.ceil(rl.retryAfterSeconds / 60);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⏳ You've used /web ${rl.count} times recently. Please try again in ~${mins} minute${mins === 1 ? '' : 's'}.`
                    )]
                });
            }

            const query = interaction.options.getString('query');
            logger.info(`[Web Command] Processing query: "${query}"`);

            // Intent check — does this question align with Christian teaching context?
            // Starts in an "unknown" state so an OpenAI outage or timeout falls
            // through to the explicit "couldn't verify" branch below rather than
            // bypassing the doctrinal filter.
            let shouldAnswer = false;
            let intentVerified = false;
            try {
                const intent_check = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: INTENT_MODEL,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a Christian content filter focused on facilitating respectful dialogue. Your task is to determine if a question:
1. Seeks genuine understanding about: Christianity, biblical topics, moral/ethical issues, scientific topics from a Christian perspective, historical/archaeological discussions related to faith, challenging questions about faith/science, honest inquiries about apparent contradictions, different Christian interpretations of Genesis/creation.
2. Return "true" if: the question seeks genuine understanding, shows respect for faith while questioning, explores scientific/historical evidence, discusses different Christian viewpoints, asks about reconciling faith/science.
3. Return "false" ONLY if: promotes hate/intentionally mocks faith, seeks validation for clearly unethical activities, shows clear hostile intent towards Christianity, uses deliberately inflammatory language, tries to promote one sect or denomination as the only true one.
Err on the side of "true" for sincere questions, even if challenging. Respond ONLY with the single word "true" or the single word "false". Do not add any other text or punctuation.`
                        },
                        { role: 'user', content: query }
                    ],
                    max_tokens: INTENT_MAX_TOKENS,
                    temperature: INTENT_TEMPERATURE
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAIKEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: INTENT_TIMEOUT_MS
                });
                const intentResponse = intent_check.data.choices[0]?.message?.content?.trim().toLowerCase();
                shouldAnswer = intentResponse === 'true';
                intentVerified = true;
            } catch (intentError) {
                logger.error(`[Web Command] Intent check failed: ${intentError.message}`);
            }

            if (!intentVerified) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `⚠️ I couldn't verify your question against the content filter right now. Please try again in a moment.`
                    )]
                });
            }

            if (!shouldAnswer) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `I can only answer questions that align with Christian teachings and biblical wisdom. Please rephrase your question or ask something else.`
                    )]
                });
            }

            // Tavily search
            let tavily_results = null;
            let retries = 0;
            while (retries <= TAVILY_MAX_RETRIES && !tavily_results) {
                try {
                    await waitForRateLimit('tavily');
                    const tavily_response = await axios.post('https://api.tavily.com/search', {
                        query: query + ' Christian perspective biblical teaching',
                        search_depth: 'advanced',
                        include_images: false,
                        max_results: TAVILY_MAX_RESULTS,
                        include_answer: true,
                        include_raw_content: false,
                        include_content: true
                    }, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
                        },
                        timeout: 10000
                    });
                    if (!tavily_response.data) throw new Error('Tavily returned no data.');
                    tavily_results = tavily_response.data;
                } catch (tavilyError) {
                    if (axios.isAxiosError(tavilyError) && tavilyError.response?.status === 429 && retries < TAVILY_MAX_RETRIES) {
                        retries++;
                        await wait(TAVILY_RETRY_DELAY_MS);
                    } else {
                        throw new Error('Failed to get search results from Tavily.');
                    }
                }
            }

            let results = (tavily_results.results || []).filter(result => {
                if (!result || !result.url || typeof result.url !== 'string') return false;
                const urlLower = result.url.toLowerCase();
                const isPDF = urlLower.endsWith('.pdf') || urlLower.includes('format=pdf') ||
                    (result.title?.toLowerCase() || '').includes('pdf') ||
                    ((result.content || result.raw_content || result.snippet || '').substring(0, 50).includes('%PDF'));
                return !isPDF && result.content;
            });

            if (results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `I couldn't find any relevant, non-PDF web results for your query.`
                    )]
                });
            }

            // Build source map from search results
            const sourceMap = new Map();
            const sourceDataForGPT = [];

            results.forEach((result, index) => {
                let derivedName = 'Source';
                try {
                    const url = new URL(result.url);
                    derivedName = url.hostname.replace(/^www\./, '');
                } catch (e) {
                    derivedName = `Source-${index + 1}`;
                }

                let uniqueName = derivedName;
                let collisionCounter = 2;
                while (sourceMap.has(uniqueName)) {
                    uniqueName = `${derivedName}-${collisionCounter}`;
                    collisionCounter++;
                }
                derivedName = uniqueName;

                sourceMap.set(derivedName, { url: result.url, title: result.title || derivedName });
                sourceDataForGPT.push(`Source ${derivedName}: ${result.title || derivedName}\nURL: ${result.url}\nContent: ${result.content || ''}`);
            });

            const sourcesForGPT = sourceDataForGPT.join('\n\n---\n\n');

            // GPT summarize
            let gptAnswer = '';
            try {
                const gpt_response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: SUMMARY_MODEL,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a thorough Christian apologetics research assistant providing factual, evidence-based info from a Protestant perspective.
Guidelines:
- Salvation is through Christ alone (John 14:6). Scripture is the ultimate authority. Avoid non-biblical traditions. Redirect non-Protestant views respectfully to biblical sources. Emphasize unity in Christ.
- Target 500–800 words written primarily as flowing prose paragraphs. Do NOT default to bullet points. Target roughly 75% prose, 25% bullets at most.
- Bullets are only appropriate for: (a) lists of three or more genuinely parallel enumerable items (e.g., three pieces of archaeological evidence), or (b) contrasting distinct viewpoints side-by-side. Any time you'd write a bullet point for a single fact or a narrative step, write a prose sentence instead.
- Format: Start with a single '## Title Derived from User Query'. Use '### Subsection Heading' only when the answer has 2+ genuinely distinct major parts. Otherwise write as continuous paragraphs under the title.
- Requirements: Base your answer EXCLUSIVELY on the provided Sources. Do not add outside knowledge. If sources don't cover an aspect, state that explicitly. Cite sources using ONLY (SourceName) where SourceName is the name provided after 'Source ' in the user prompt (e.g., (christianity.com), (gotquestions.org)). Cite ALL evidence/facts. Only referenced sources will be listed. Adhere to doctrinal guidelines, especially for denominational questions.`
                        },
                        {
                            role: 'user',
                            content: `Query: "${query}"

Based *only* on the provided sources below, write a thorough, evidence-focused answer (500–800 words, follow ALL system guidelines — primarily prose, bullets only for genuine 3+ item enumerations).

Incorporate where the sources support it: historical evidence and dates, archaeological findings, biblical references, specific names and places, verifiable facts, and multiple viewpoints when sources present them — but weave these into prose rather than bulleting them.

Cite every claim. Prefer prose.

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
                    timeout: 20000
                });
                gptAnswer = gpt_response.data.choices[0]?.message?.content || '';
                if (!gptAnswer) throw new Error('GPT returned an empty answer.');
            } catch (summaryError) {
                logger.error(`[Web Command] GPT summary failed: ${summaryError.message}`);
                if (tavily_results.answer) {
                    gptAnswer = tavily_results.answer;
                } else {
                    throw new Error('Failed to generate a summary for the search results.');
                }
            }

            // Process citation markdown — replace (sourcename) with [(sourcename)](url).
            const usedSourceNames = new Set();
            let finalAnswer = gptAnswer.replace(/\(([\w.-]+(?:-\d+)?)\)/g, (match, sourceName) => {
                if (sourceMap.has(sourceName)) {
                    usedSourceNames.add(sourceName);
                    const sourceInfo = sourceMap.get(sourceName);
                    return `[(${sourceName})](${sourceInfo.url})`;
                }
                return match;
            });

            const usedSources = Array.from(usedSourceNames).sort().map(name => ({
                name,
                info: sourceMap.get(name)
            }));

            // Paginate if the answer exceeds one page. splitString breaks at
            // word/paragraph boundaries so markdown citations stay intact.
            const chunks = splitString(finalAnswer, MAX_CHARS_PER_PAGE);
            const totalPages = chunks.length;

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildWebAnswerPage({ query, chunks, pageIdx: 0, totalPages, usedSources })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Web Command]',
                render: (pageIdx, { disableNav }) =>
                    buildWebAnswerPage({ query, chunks, pageIdx, totalPages, usedSources, disableNav })
            });
        } catch (error) {
            logger.error(`[Web Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, an unexpected error occurred while processing your web search: ${error.message}`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Web Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
};
