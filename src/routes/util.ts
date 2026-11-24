import type { Request } from 'express';
import type { Config } from '../config.ts';

/**
 * Public origin for links: the configured BASE_URL, else the request's own origin. The fallback
 * only applies without TRUST_PROXY (loadConfig refuses TRUST_PROXY without BASE_URL), and uses the
 * Host header, never X-Forwarded-Host.
 */
export const baseUrlOf = (config: Config, req: Request) => config.baseUrl || `${req.protocol}://${req.get('host')}`;
