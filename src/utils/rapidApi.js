import axios from 'axios';

const IQ_BIBLE_HOST = 'iq-bible.p.rapidapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;

// Thin wrapper for the iq-bible RapidAPI endpoints. Commands pass the path
// (e.g. 'GetAudioNarration') and params; auth + host + timeout are unified.
export function fetchIQBible(endpoint, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return axios.request({
        method: 'GET',
        url: `https://${IQ_BIBLE_HOST}/${endpoint}`,
        params,
        headers: {
            'x-rapidapi-key': process.env.RAPIDAPIKEY,
            'x-rapidapi-host': IQ_BIBLE_HOST
        },
        timeout: timeoutMs
    });
}
