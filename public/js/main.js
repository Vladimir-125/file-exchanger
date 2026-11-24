// Entry point: loads config and session, then routes.
//   /         Send        /receive   Receive (key form)
//   /account  Account     /<key>     Receive that key (direct first, then stored)

import { api, friendlyError } from './api.js';
import * as account from './account.js';
import * as receive from './receive.js';
import * as send from './send.js';
import { $, setText, showView } from './ui.js';

const app = {
  config: null,
  user: null,
  navigate(path) {
    if (location.pathname !== path) history.pushState(null, '', path);
    route();
  },
  setUser(user) {
    app.user = user;
    send.refreshUser();
  },
};

function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return send.show();
  if (path === '/receive') return receive.showForm();
  if (path === '/account') return account.show();
  const key = path.slice(1);
  if (!key.includes('/')) return receive.open(key);
  app.navigate('/');
}

// same-page links: <a data-nav> and any in-app link marked so by the views
document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-nav]') : null;
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  app.navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', route);

async function start() {
  try {
    const [config, me] = await Promise.all([api.config(), api.me()]);
    app.config = config;
    app.user = me.user;
  } catch (err) {
    showView('send');
    setText('send-error', `File Exchanger could not load: ${friendlyError(err)}`);
    return;
  }
  send.init(app);
  receive.init(app);
  account.init(app);
  route();
}

$('main').setAttribute('aria-busy', 'true');
start().finally(() => $('main').removeAttribute('aria-busy'));
