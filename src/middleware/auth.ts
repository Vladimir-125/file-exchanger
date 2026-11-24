import type { RequestHandler } from 'express';
import { HttpError } from '../errors.ts';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
  }
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (req.session?.userId === undefined) return next(new HttpError(401, 'auth_required', 'Sign in required'));
  next();
};
