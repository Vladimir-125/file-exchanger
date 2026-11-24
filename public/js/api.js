// Thin wrapper over the HTTP API. Pure: `fetch` is looked up only when a request is made, or
// passed in, so this module also loads in Node for tests.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 for a network failure)
   * @param {string} code machine-readable code from `{ error: { code } }`
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const defaultFetch = (...args) => globalThis.fetch(...args);

/** Turns a non-OK response into an ApiError, reading the JSON error shape when there is one. */
export async function errorFrom(res) {
  let code = 'http_error';
  let message = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body && body.error && typeof body.error.code === 'string') {
      code = body.error.code;
      if (typeof body.error.message === 'string') message = body.error.message;
    }
  } catch {
    // not JSON: keep the generic message
  }
  return new ApiError(res.status, code, message);
}

/**
 * Sends one request. `json` becomes a JSON body; `body` is sent raw. Resolves to the parsed JSON
 * response, or null for an empty one; rejects with ApiError.
 */
export async function request(url, { method = 'GET', json, body, headers = {}, fetch = defaultFetch } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

export const api = {
  config: () => request('/api/config'),
  me: () => request('/api/me'),
  signup: (name, email, password) => request('/api/auth/signup', { method: 'POST', json: { name, email, password } }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', json: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  myTransfers: () => request('/api/me/transfers'),
  lookup: (key) => request(`/api/transfers/${enc(key)}`),
  unlock: (key, password) => request(`/api/transfers/${enc(key)}/unlock`, { method: 'POST', json: { password } }),
  remove: (key) => request(`/api/transfers/${enc(key)}`, { method: 'DELETE' }),
};

/** Download URL of one file; `grant` comes from unlocking a protected transfer. */
export function fileUrl(key, fileId, grant) {
  const q = grant ? `?grant=${enc(grant)}` : '';
  return `/api/transfers/${enc(key)}/files/${enc(fileId)}${q}`;
}

export function zipUrl(key, grant) {
  const q = grant ? `?grant=${enc(grant)}` : '';
  return `/api/transfers/${enc(key)}/zip${q}`;
}

const FRIENDLY = {
  network: 'Could not reach the server. Check your connection.',
  rate_limited: 'Too many requests right now. Please wait a few minutes and try again.',
  storage_full: 'The server is out of storage space right now. Please try again later.',
  auth_required: 'Please sign in first.',
  not_found: 'Nothing found for this key. It may have expired.',
  wrong_password: 'Wrong password.',
  invalid_credentials: 'Wrong email or password.',
  email_unconfirmed: 'Confirm your email first: check your inbox for the confirmation link.',
  upload_lost: 'The server restarted during this upload. Please start again.',
  invalid_request: 'Please check the form and try again.',
};

/** A message for people, from any error thrown by the API helpers. */
export function friendlyError(err) {
  if (err instanceof ApiError) return FRIENDLY[err.code] ?? err.message;
  return err && err.message ? err.message : 'Something went wrong.';
}
