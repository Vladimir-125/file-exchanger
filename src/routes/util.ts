import type { Request } from 'express';
import type { Config } from '../config.ts';

/** Public origin for links: the configured BASE_URL, else the request's own origin. */
export const baseUrlOf = (config: Config, req: Request) => config.baseUrl || `${req.protocol}://${req.host}`;
