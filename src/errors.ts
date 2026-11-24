import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid request' } });
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Malformed JSON body' } });
  } else if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
  } else {
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
};
