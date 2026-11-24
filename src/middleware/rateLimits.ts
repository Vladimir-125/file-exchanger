import { rateLimit } from 'express-rate-limit';

export type LimitName = 'auth' | 'lookup' | 'upload' | 'ws';
export type RateLimits = Record<LimitName, ReturnType<typeof rateLimit>>;

const WINDOWS: Record<LimitName, { windowMs: number; limit: number }> = {
  auth: { windowMs: 15 * 60_000, limit: 20 },
  lookup: { windowMs: 60_000, limit: 60 },
  upload: { windowMs: 3600_000, limit: 30 },
  ws: { windowMs: 3600_000, limit: 30 },
};

export function createRateLimits(overrides: Partial<Record<LimitName, number>> = {}): RateLimits {
  const make = (name: LimitName) =>
    rateLimit({
      windowMs: WINDOWS[name].windowMs,
      limit: overrides[name] ?? WINDOWS[name].limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
      },
    });
  return { auth: make('auth'), lookup: make('lookup'), upload: make('upload'), ws: make('ws') };
}
