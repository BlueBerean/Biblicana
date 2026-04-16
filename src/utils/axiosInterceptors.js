import axios from 'axios';
import logger from './logger.js';

function setupAxiosInterceptors() {
    // Add request logging interceptor
    axios.interceptors.request.use(request => {
        // Log the request without exposing full auth tokens
        const authHeader = request.headers['Authorization'] || request.headers['authorization'];
        let authLogged = 'Not present';
        if (authHeader) {
            // Only log first 15 chars of token
            authLogged = authHeader.substring(0, 15) + '...';
        }

        logger.info(`[API Request] ${request.method.toUpperCase()} ${request.url}`);
        logger.info(`[API Request] Headers: Auth=${authLogged}`);
        // Safely log request data only if it exists
        if (request.data) {
            try {
                const dataString = JSON.stringify(request.data);
                logger.info(`[API Request] Request Data: ${dataString.substring(0, 200)}${dataString.length > 200 ? '...' : ''}`);
            } catch (e) {
                logger.error(`[API Request] Error stringifying request data: ${e.message}`);
            }
        } else {
            logger.info('[API Request] Request Data: None');
        }
        return request;
    }, error => {
        logger.error(`[API Request Error] ${error}`);
        return Promise.reject(error);
    });

    // Add response logging interceptor
    axios.interceptors.response.use(response => {
        logger.info(`[API Response] ${response.status} from ${response.config.url}`);
        logger.info(`[API Response] Response Length: ${JSON.stringify(response.data).length} chars`);
        return response;
    }, error => {
        if (error.response) {
            logger.error(`[API Response Error] ${error.response.status} ${error.response.statusText} from ${error.config.url}`);
            logger.error(`[API Response Error] Data: ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`[API Connection Error] ${error.message}`);
        }
        return Promise.reject(error);
    });
}

export default setupAxiosInterceptors;
