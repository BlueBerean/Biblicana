import axios from 'axios';
import logger from './logger.js';

function setupAxiosInterceptors() {
    axios.interceptors.request.use(request => {
        // Log the request shape without touching the Authorization header at all —
        // prior versions echoed the first 15 chars, which leaked 1–2 bytes of the
        // actual key for short-prefix schemes ("Bearer tvly-...").
        const authHeader = request.headers['Authorization'] || request.headers['authorization'];
        const authScheme = authHeader ? String(authHeader).split(' ')[0] : 'none';
        logger.debug(`[API Request] ${request.method.toUpperCase()} ${request.url} (auth=${authScheme})`);
        return request;
    }, error => {
        logger.error(`[API Request Error] ${error}`);
        return Promise.reject(error);
    });

    axios.interceptors.response.use(response => {
        // Use Content-Length when the server provides it. Falls back to the axios
        // transfer-length estimate; never re-serialize response.data on the hot
        // path — that cost can dwarf the actual request for large payloads.
        const len = response.headers?.['content-length'] ?? response.request?.res?.socket?.bytesRead ?? '?';
        logger.debug(`[API Response] ${response.status} from ${response.config.url} (${len} bytes)`);
        return response;
    }, error => {
        if (error.response) {
            // Surface the provider's OWN error message, not just the status.
            // A bare "400 Bad Request" hides the one detail that makes a 4xx
            // actionable: OpenAI names the offending parameter outright
            // ("Unsupported parameter: 'max_tokens' is not supported with this
            // model"), and without it a model swap looks like a mystery outage.
            // Response bodies from these APIs carry no credentials.
            const body = error.response.data;
            const detail = body?.error?.message
                ?? (typeof body === 'string' ? body.slice(0, 300) : null);
            const code = body?.error?.code ? ` code=${body.error.code}` : '';
            const param = body?.error?.param ? ` param=${body.error.param}` : '';
            logger.error(
                `[API Response Error] ${error.response.status} ${error.response.statusText} from ${error.config?.url}`
                + `${detail ? ` — ${detail}` : ''}${code}${param}`
            );
        } else {
            logger.error(`[API Connection Error] ${error.message}`);
        }
        return Promise.reject(error);
    });
}

export default setupAxiosInterceptors;
