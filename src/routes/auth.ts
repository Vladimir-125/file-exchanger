import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import type { Deps } from '../app.ts';
import type { RateLimits } from '../middleware/rateLimits.ts';
import { baseUrlOf } from './util.ts';
import { createUserService } from '../services/users.ts';
import type { User } from '../db/schema.ts';

const signupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(8).max(200),
});
const loginBody = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(200) });

const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email });

const regenerate = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
const save = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
const destroy = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));

export function authRouters(deps: Deps, limits: RateLimits): { api: Router; confirm: Router } {
  const users = createUserService(deps);
  const json = express.json({ limit: '1mb' });

  const api = Router();
  api.post('/auth/signup', limits.auth, json, async (req, res) => {
    const body = signupBody.parse(req.body);
    await users.signup(body, baseUrlOf(deps.config, req));
    res.status(202).json({ ok: true });
  });
  api.post('/auth/login', limits.auth, json, async (req, res) => {
    const body = loginBody.parse(req.body);
    const user = await users.login(body.email, body.password);
    await regenerate(req);
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
  api.post('/auth/logout', async (req, res) => {
    await destroy(req);
    res.clearCookie('fx_sid');
    res.status(204).end();
  });
  api.get('/me', (req, res) => {
    const user = req.session.userId === undefined ? undefined : users.get(req.session.userId);
    res.json({ user: user ? publicUser(user) : null });
  });

  const confirm = Router();
  confirm.get('/confirm/:token', async (req, res, next) => {
    try {
      const userId = await users.confirm(String(req.params.token));
      await regenerate(req);
      req.session.userId = userId;
      await save(req);
      res.redirect('/');
    } catch (err) {
      if (err instanceof HttpError && err.code === 'invalid_token') {
        res.status(404).type('text/plain').send('This confirmation link is invalid or has expired.');
      } else next(err);
    }
  });
  return { api, confirm };
}
