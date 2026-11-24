// Receive view (stored transfers, password unlock) and the direct receiver.

import { api, fileUrl, friendlyError, zipUrl } from './api.js';
import { createPeer, joinOutcome, openSignaling, receiveFiles, wsUrl } from './direct.js';
import { $, countdown, fileRow, h, onLeave, progress, setText, showView } from './ui.js';

const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const JOIN_TIMEOUT_MS = 5_000; // no answer from signaling: fall back to the stored lookup

let app;
let current = null; // key whose stored transfer the view shows

/** Normalized like the server: uppercase, no whitespace or dashes; null when it cannot be a key. */
export function normalizeKey(input, length) {
  const key = String(input).replace(/[\s-]/g, '').toUpperCase();
  if (key.length !== length) return null;
  for (const ch of key) if (!KEY_ALPHABET.includes(ch)) return null;
  return key;
}

export function init(ctx) {
  app = ctx;
  $('key-input').maxLength = app.config.keyLength + 1; // room for one separator, as in K7P-X3M
  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = normalizeKey($('key-input').value, app.config.keyLength);
    if (!key) return setText('receive-error', `A key has ${app.config.keyLength} letters and digits, for example K7PX3M.`);
    app.navigate(`/${key}`);
  });
  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!current) return;
    const key = current;
    setText('receive-error', '');
    setText('receive-status', 'Checking the password...');
    try {
      const { grant, files } = await api.unlock(key, $('unlock-password').value);
      if (current !== key) return;
      $('unlock-password').value = '';
      $('unlock-form').hidden = true;
      setText('receive-status', '');
      renderFiles(key, files, grant);
    } catch (err) {
      setText('receive-status', '');
      setText('receive-error', friendlyError(err));
      $('unlock-password').select();
    }
  });
}

function resetReceive() {
  current = null;
  $('unlock-form').hidden = true;
  $('receive-box').hidden = true;
  $('receive-files').replaceChildren();
  setText('receive-status', '');
  setText('receive-error', '');
}

/** The empty key form. */
export function showForm() {
  showView('receive');
  resetReceive();
  $('key-form').hidden = false;
  $('key-input').value = '';
  $('key-input').focus();
}

/** `/<key>`: try a live direct transfer first, else the stored transfer. */
export function open(raw) {
  const key = normalizeKey(raw, app.config.keyLength);
  showView('receive');
  resetReceive();
  $('key-input').value = key ?? raw;
  if (!key) {
    setText('receive-error', 'This is not a valid key. Check it and try again.');
    return;
  }
  setText('receive-status', 'Looking up the key...');
  joinLive(key);
}

function joinLive(key) {
  let settled = false;
  let joined = false;
  const fallBack = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sig.close();
    loadStored(key);
  };
  const timer = setTimeout(fallBack, JOIN_TIMEOUT_MS);
  const sig = openSignaling(wsUrl(location), (msg) => {
    if (settled) return;
    const outcome = joinOutcome(msg);
    if (outcome === 'direct') {
      settled = true;
      joined = true;
      clearTimeout(timer);
      receiveDirect(key, sig, msg.iceServers);
    } else if (outcome === 'busy') {
      settled = true;
      clearTimeout(timer);
      sig.close();
      setText('receive-status', '');
      setText('receive-error', 'Someone else is already receiving these files. Ask the sender to start again.');
    } else {
      // not-live, not-found, any error (rate_limited too) or the socket failed: the HTTP lookup
      // decides and reports its own 404/429
      fallBack();
    }
  });
  sig.sendWhenOpen({ type: 'join', key });
  onLeave(() => {
    settled = true;
    clearTimeout(timer);
    if (!joined) sig.close(); // a joined socket now belongs to the direct receiver
  });
}

/** Stored transfer: metadata, password prompt when protected, download links. */
export async function loadStored(key) {
  showView('receive');
  resetReceive();
  current = key;
  $('key-input').value = key;
  setText('receive-status', 'Looking up the key...');
  let view;
  try {
    view = await api.lookup(key);
  } catch (err) {
    if (current !== key) return;
    setText('receive-status', '');
    setText('receive-error', friendlyError(err));
    return;
  }
  if (current !== key) return;
  setText('receive-status', '');
  setText('receive-key', `Key ${view.key}`);
  $('receive-box').hidden = false;
  countdown($('receive-expiry'), view.expiresAt);
  if (view.files) {
    renderFiles(key, view.files);
  } else {
    $('receive-zip').hidden = true;
    $('unlock-form').hidden = false;
    $('unlock-password').focus();
  }
}

function renderFiles(key, files, grant) {
  $('receive-box').hidden = false;
  $('receive-files').replaceChildren(
    ...files.map((f) =>
      fileRow(
        f.name,
        f.size,
        h('a', { className: 'btn small-btn', href: fileUrl(key, f.fileId, grant), download: f.name, 'aria-label': `Download ${f.name}` }, 'Download'),
      ),
    ),
  );
  const zip = $('receive-zip');
  zip.href = zipUrl(key, grant);
  zip.download = `${key}.zip`;
  zip.hidden = files.length < 2;
}

/** Direct receiver: answer the sender's offer and collect files from the data channel. */
function receiveDirect(key, sig, iceServers) {
  showView('direct');
  $('direct-sender').hidden = true;
  $('direct-fallback').hidden = true;
  $('direct-progress').hidden = true;
  $('direct-files').replaceChildren();
  setText('direct-error', '');
  setText('direct-status', 'Connected to the sender. Setting up a direct connection...');

  let phase = 'connecting'; // connecting -> receiving -> done; or failed / switched
  const urls = [];
  const onProgress = progress('direct-bar', 'direct-progress-text', 'Received');
  const fail = (text) => {
    if (phase === 'done' || phase === 'switched') return;
    phase = 'failed';
    setText('direct-status', '');
    setText('direct-error', text);
    sig.close();
    peer.close();
  };

  const peer = createPeer({
    iceServers,
    initiator: false,
    sendSignal: (data) => sig.send({ type: 'signal', data }),
    // the sender is offered an upload instead; the socket stays open for its switch-to-download
    onFailed: () =>
      phase === 'connecting' &&
      setText('direct-status', 'Could not connect directly. Waiting for the sender to upload the files instead...'),
    onChannel: (channel) => {
      channel.onopen = () => {
        phase = 'receiving';
        $('direct-progress').hidden = false;
        setText('direct-status', 'Receiving...');
      };
      receiveFiles(
        channel,
        (file) => {
          const url = URL.createObjectURL(file.blob);
          urls.push(url);
          $('direct-files').append(
            fileRow(
              file.name,
              file.size,
              h('a', { className: 'btn small-btn', href: url, download: file.name, 'aria-label': `Save ${file.name}` }, 'Save'),
            ),
          );
        },
        onProgress,
      ).then(
        () => {
          phase = 'done';
          setText('direct-status', 'All files received. Save them before leaving this page.');
          sig.close();
        },
        () => fail('The connection dropped before every file arrived.'),
      );
    },
  });

  sig.onMessage = (msg) => {
    if (msg.type === 'signal') peer.handleSignal(msg.data);
    else if (msg.type === 'switch-to-download') {
      phase = 'switched'; // the sender uploaded the files instead: they are a stored transfer now
      loadStored(String(msg.key));
    } else if (msg.type === 'peer-left') fail('The sender left before the transfer finished.');
    else if (msg.type === 'expired') fail('The sender is no longer available.');
    else if (msg.type === 'closed' && phase === 'connecting') fail('Lost the connection to the server.');
  };

  $('btn-direct-cancel').onclick = () => app.navigate('/receive');
  onLeave(() => {
    if (phase !== 'done') phase = 'failed';
    sig.close();
    peer.close();
    for (const url of urls) URL.revokeObjectURL(url);
  });
}
