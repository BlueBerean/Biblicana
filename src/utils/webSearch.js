import axios from 'axios';
import logger from './logger.js';
import 'dotenv/config';

// Shared web-search layer for /web and the AI chat's search_web tool.
//
// Extracted so the allowlist has exactly ONE definition. Two copies of a
// trust boundary is two copies that drift, and the drift would be silent —
// a domain added for /web but missing here would simply never be searched
// from chat, with nothing to indicate why.

const WEB_SEARCH_MODEL = 'gpt-5.6-luna';
const DEFAULT_TIMEOUT_MS = 60_000;   // search + generation in one call
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

// Domains the bot is allowed to search. Enforced SERVER-SIDE by the web_search
// tool, so nothing outside this list can reach an answer — a hard constraint,
// unlike the previous approach of appending "Christian perspective biblical
// teaching" to a query and hoping the open web cooperated.
//
// Deliberately cross-denominational: the non-Protestant entries let contested
// questions be answered from a tradition's OWN words rather than only from
// critiques of it. Doctrinal stance comes from the caller's instructions, not
// from starving the model of primary sources.
//
// Omit the scheme; subdomains are included automatically. Max 100 entries.
export const ALLOWED_DOMAINS = [
    // Primary texts, lexicons, and study tools.
    'ccel.org',             // Christian Classics Ethereal Library — public-domain primary texts
    'newadvent.org',        // Church Fathers, Summa, Catholic Encyclopedia
    'biblehub.com',         // interlinear, lexicons, parallel translations
    'blueletterbible.org',  // Strong's, lexicons, concordance
    'stepbible.org',        // Tyndale House — scholarly open Bible tools
    'biblicaltraining.org', // seminary-level lecture material
    'bible.org',            // NET Bible + translators' notes
    'chapellibrary.org',    // public-domain Puritan / Reformed literature

    // Teaching ministries and Q&A.
    'thegospelcoalition.org',
    'desiringgod.org',
    'ligonier.org',
    'gotquestions.org',     // Got Questions Ministries
    'compellingtruth.org',  // same ministry as gotquestions.org
    'carm.org',             // Christian Apologetics & Research Ministry
    'answersingenesis.org', // young-earth creation apologetics
    'creation.com',         // Creation Ministries International — likewise

    // Non-Protestant traditions. Present so contested questions can be answered
    // from more than one tradition's own words rather than only from critiques
    // of it — see the cross-denominational note above.
    'catholic.com',
    'oca.org',              // Orthodox Church in America
];

/**
 * Search the allowlisted web and return the model's answer plus provenance.
 *
 * Responses API rather than Chat Completions: filters.allowed_domains is only
 * supported there. Note the parameter shapes differ between the two endpoints —
 * Responses nests reasoning under `reasoning.effort` and caps output with
 * `max_output_tokens`, where Chat Completions uses flat `reasoning_effort` and
 * `max_completion_tokens`.
 *
 * @returns {{text: string, annotations: object[], retrieved: object[], searchCallCount: number}}
 */
export async function searchAllowedWeb({
    query,
    instructions,
    maxOutputTokens = 4000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    const response = await axios.post(RESPONSES_URL, {
        model: WEB_SEARCH_MODEL,
        instructions,
        input: query,
        // Without this, web_search_call items come back with no sources array,
        // so a run where the model doesn't inline-cite yields no URLs at all.
        include: ['web_search_call.action.sources'],
        tools: [{
            type: 'web_search',
            filters: { allowed_domains: ALLOWED_DOMAINS },
        }],
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: 'none' },
        // temperature omitted — this model family only accepts the default.
    }, {
        headers: {
            'Authorization': `Bearer ${process.env.OPENAIKEY}`,
            'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
    });

    // output is a mixed array: web_search_call items plus the assistant
    // message. Find by type rather than index — the number of search calls
    // varies with the question.
    const output = response.data?.output ?? [];
    const messageItem = output.find(item => item.type === 'message');
    const textBlock = messageItem?.content?.find(part => part.type === 'output_text');
    const searchCalls = output.filter(item => item.type === 'web_search_call');

    return {
        text: textBlock?.text ?? '',
        annotations: (textBlock?.annotations ?? []).filter(a => a.type === 'url_citation'),
        retrieved: searchCalls.flatMap(item => item.action?.sources ?? item.sources ?? []),
        searchCallCount: searchCalls.length,
    };
}

/**
 * Build a hostname-keyed source map from a search result.
 *
 * Prefers inline citations — those are what the model actually leaned on — and
 * falls back to everything retrieved, because the model does not always emit
 * url_citation annotations even on a well-sourced answer (observed live: a
 * 5,696-character answer with zero citations).
 *
 * Only URLs the API actually reported are included, so a hallucinated domain
 * fails to match and stays plain text rather than becoming a broken link.
 */
export function buildWebSourceMap({ annotations = [], retrieved = [] }) {
    const sourceMap = new Map();
    const add = (url, title) => {
        if (!url || typeof url !== 'string') return;
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return;   // unparseable URL — no way to cite it
        }
        if (!sourceMap.has(host)) sourceMap.set(host, { url, title: title || host });
    };

    for (const annotation of annotations) add(annotation.url, annotation.title);
    if (sourceMap.size === 0) {
        for (const source of retrieved) add(source.url, source.title);
        if (sourceMap.size > 0) {
            logger.debug(`[WebSearch] No inline citations; fell back to ${sourceMap.size} retrieved source(s).`);
        }
    }
    return sourceMap;
}
