// Account view: sign in, sign up, sign out, and the signed-in user's transfers.

import { api, friendlyError } from './api.js';
import { $, fileRow, formatDuration, h, setText, showView } from './ui.js';

let app;
let loadId = 0;

export function init(ctx) {
  app = ctx;

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setText('login-error', '');
    try {
      const { user } = await api.login($('login-email').value.trim(), $('login-password').value);
      $('login-form').reset();
      app.setUser(user);
      show();
    } catch (err) {
      setText('login-error', friendlyError(err));
    }
  });

  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setText('signup-error', '');
    setText('signup-status', '');
    try {
      await api.signup($('signup-name').value.trim(), $('signup-email').value.trim(), $('signup-password').value);
      $('signup-form').reset();
      setText('signup-status', 'Check your email for a confirmation link.');
    } catch (err) {
      setText('signup-error', friendlyError(err));
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      // the session is gone either way
    }
    app.setUser(null);
    show();
  });
}

export function show() {
  showView('account');
  const user = app.user;
  $('account-out').hidden = Boolean(user);
  $('account-in').hidden = !user;
  if (!user) return;
  setText('account-name', user.name);
  setText('account-email', `(${user.email})`);
  void loadTransfers();
}

async function loadTransfers() {
  const id = ++loadId;
  setText('my-error', '');
  let transfers;
  try {
    ({ transfers } = await api.myTransfers());
  } catch (err) {
    if (id !== loadId) return;
    if (err.status === 401) {
      app.setUser(null); // the session expired
      return show();
    }
    setText('my-error', friendlyError(err));
    return;
  }
  if (id !== loadId) return;
  $('my-empty').hidden = transfers.length > 0;
  $('my-transfers').replaceChildren(...transfers.map(transferRow));
}

function transferRow(t) {
  const size = t.files.reduce((sum, f) => sum + f.size, 0);
  const names = t.files.map((f) => f.name).join(', ');
  const left = formatDuration(t.expiresAt - Date.now());
  const remove = h(
    'button',
    {
      type: 'button',
      className: 'btn small-btn',
      'aria-label': `Delete transfer ${t.key}`,
      onclick: async () => {
        if (!window.confirm(`Delete transfer ${t.key}? Its files will no longer be available.`)) return;
        remove.disabled = true;
        try {
          await api.remove(t.key);
          await loadTransfers();
        } catch (err) {
          remove.disabled = false;
          setText('my-error', friendlyError(err));
        }
      },
    },
    'Delete',
  );
  const row = fileRow(t.key, size, h('a', { href: `/${t.key}`, 'data-nav': '', className: 'btn small-btn' }, 'Open'), remove);
  row.querySelector('.name').classList.add('key-line');
  row.append(
    h(
      'span',
      { className: 'meta' },
      `${t.files.length} file${t.files.length === 1 ? '' : 's'}${t.protected ? ', password protected' : ''}. ` +
        `Expires in ${left}. ${names}`,
    ),
  );
  return row;
}
