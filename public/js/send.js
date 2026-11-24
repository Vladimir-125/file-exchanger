// Send view (pick files, upload or send directly), Result view, and the direct sender.

import { friendlyError } from './api.js';
import { createPeer, openSignaling, sendFiles, wsUrl } from './direct.js';
import { renderQr } from './qr.js';
import { $, copyText, countdown, currentView, fileRow, h, onLeave, progress, setText, showView } from './ui.js';
import { checkLimits, formatBytes, uploadTransfer, xhrPutChunk } from './upload.js';

const CONNECT_TIMEOUT_MS = 15_000; // after the receiver joins

let app;
let selected = [];
let busy = false;
let running = 0; // uploads in flight (plain or fallback): leaving the page would lose them

export function init(ctx) {
  app = ctx;
  const { maxFilesPerTransfer, maxFileBytes, maxTransferBytes, transferTtlMs } = app.config;
  setText(
    'limits',
    `Up to ${maxFilesPerTransfer} files, ${formatBytes(maxFileBytes)} each, ${formatBytes(maxTransferBytes)} in total. ` +
      `Uploads are kept for ${formatTtl(transferTtlMs)}.`,
  );

  const input = $('file-input');
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer?.files ?? []);
  });

  $('btn-upload').addEventListener('click', upload);
  $('btn-direct').addEventListener('click', () => startDirect(selected.slice()));
  $('btn-send-more').addEventListener('click', () => {
    selected = [];
    renderSelection();
    setText('send-error', '');
    $('send-progress').hidden = true;
    app.navigate('/');
  });
  // a direct transfer cannot carry a password: typing one turns "Send directly" off
  $('send-password').addEventListener('input', renderSelection);
  window.addEventListener('beforeunload', (e) => {
    if (running === 0) return;
    e.preventDefault();
    e.returnValue = ''; // older browsers need it to show the prompt
  });
  refreshUser();
}

/** Counts an upload as running until `promise` settles. */
async function tracked(promise) {
  running++;
  try {
    return await promise;
  } finally {
    running--;
  }
}

/**
 * An upload finished after the person left the view it started from: its key goes to a notice
 * shown on every view, so it is never lost. The old view itself is not touched.
 */
function notifyFinished(ready) {
  const item = h(
    'li',
    { className: 'notice' },
    h('p', {}, `Your upload is ready. Key: ${ready.key}`),
    h(
      'div',
      { className: 'actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'btn primary',
          onclick: () => {
            item.remove();
            if (location.pathname !== '/') history.pushState(null, '', '/');
            showResult(ready);
          },
        },
        'Show key and link',
      ),
      h('button', { type: 'button', className: 'btn', onclick: () => item.remove() }, 'Dismiss'),
    ),
  );
  $('upload-notices').append(item);
}

function notifyFailed(err) {
  const item = h(
    'li',
    { className: 'notice' },
    h('p', { className: 'error' }, `An upload you started could not finish: ${friendlyError(err)}`),
    h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn', onclick: () => item.remove() }, 'Dismiss')),
  );
  $('upload-notices').append(item);
}

/** Clears the selection if it still holds exactly these files (they have been sent). */
function clearSelectionOf(files) {
  if (selected.length === files.length && files.every((f, i) => selected[i] === f)) selected = [];
}

function formatTtl(ms) {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} minute${min === 1 ? '' : 's'}`;
}

export function show() {
  showView('send');
  renderSelection();
}

/** Shows the password field only to signed-in users. */
export function refreshUser() {
  const signedIn = Boolean(app?.user);
  $('password-row').hidden = !signedIn;
  $('password-note').hidden = signedIn;
  if (!signedIn) $('send-password').value = '';
  renderSelection();
}

function addFiles(list) {
  for (const f of Array.from(list)) {
    const dup = selected.some((s) => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified);
    if (!dup) selected.push(f);
  }
  setText('send-error', '');
  renderSelection();
}

function renderSelection() {
  const list = $('send-files');
  list.replaceChildren(
    ...selected.map((f, i) =>
      fileRow(
        f.name,
        f.size,
        h(
          'button',
          {
            type: 'button',
            className: 'btn small-btn',
            'aria-label': `Remove ${f.name}`,
            disabled: busy,
            onclick: () => {
              selected.splice(i, 1);
              renderSelection();
            },
          },
          'Remove',
        ),
      ),
    ),
  );
  const total = selected.reduce((sum, f) => sum + f.size, 0);
  $('send-total').hidden = selected.length === 0;
  setText('send-total', `${selected.length} file${selected.length === 1 ? '' : 's'}, ${formatBytes(total)}`);
  $('btn-upload').disabled = busy || selected.length === 0;
  const hasPassword = $('send-password').value !== '';
  $('btn-direct').disabled = busy || selected.length === 0 || hasPassword;
  $('direct-password-note').hidden = !hasPassword;
}

function setBusy(value) {
  busy = value;
  $('file-input').disabled = value;
  renderSelection();
}

async function upload() {
  const problem = checkLimits(selected, app.config);
  if (problem) return setText('send-error', problem);
  setText('send-error', '');
  setBusy(true);
  $('send-progress').hidden = false;
  const view = currentView();
  const mine = () => currentView() === view; // still on the Send view this upload started from
  const bar = progress('send-bar', 'send-progress-text', 'Uploaded');
  const onProgress = (sent, total) => mine() && bar(sent, total);
  const files = selected.slice();
  try {
    const password = app.user ? $('send-password').value : '';
    const ready = await tracked(
      uploadTransfer(files, { password: password || undefined, onProgress, putChunk: xhrPutChunk }),
    );
    $('send-progress').hidden = true;
    clearSelectionOf(files);
    $('send-password').value = '';
    if (mine()) showResult(ready);
    else notifyFinished(ready);
  } catch (err) {
    $('send-progress').hidden = true;
    if (mine()) setText('send-error', friendlyError(err));
    else notifyFailed(err);
  } finally {
    setBusy(false);
  }
}

function shareUrl(key) {
  return `${location.origin}/${key}`;
}

/** Result view for a stored transfer. */
export function showResult(ready) {
  showView('result');
  setText('result-key', ready.key);
  const url = ready.url || shareUrl(ready.key);
  $('result-url').value = url;
  setText('copy-status', '');
  $('btn-copy').onclick = () => copyText(url, $('result-url'), $('copy-status'));
  renderQr($('result-qr'), url);
  $('result-protected').hidden = !ready.protected;
  countdown($('result-expiry'), ready.expiresAt);
  $('result-files').replaceChildren(...ready.files.map((f) => fileRow(f.name, f.size)));
}

/** Direct sender: host a live key, wait for a receiver, then stream over WebRTC. */
function startDirect(files) {
  if (files.length === 0) return;
  showView('direct');
  $('direct-sender').hidden = false;
  $('direct-fallback').hidden = true;
  $('direct-progress').hidden = true;
  $('direct-files').replaceChildren();
  setText('direct-key', '');
  setText('direct-error', '');
  $('direct-url').value = '';
  $('direct-qr').replaceChildren();
  setText('direct-expiry', '');
  setText('direct-copy-status', '');
  setText('direct-status', 'Connecting to the server...');
  const view = currentView();
  const mine = () => currentView() === view; // false once this session's view was left

  // phase: hosting -> waiting -> connecting -> sending -> done; or uploading (fallback) / failed
  let phase = 'hosting';
  let live = null; // { key, liveToken, iceServers }
  let peer = null;
  let timer = null;
  let generation = 0; // bumps whenever a peer is dropped, so its late callbacks are ignored
  let stopCountdown = () => {};
  const onProgress = progress('direct-bar', 'direct-progress-text', 'Sent');

  // a stale session (e.g. a fallback upload finishing after the view was left) never writes the page
  const status = (text) => mine() && setText('direct-status', text);
  const fail = (text) => {
    phase = 'failed';
    dropPeer();
    sig.close();
    if (!mine()) return;
    status('');
    setText('direct-error', text);
    $('direct-fallback').hidden = true;
  };
  function dropPeer() {
    generation++;
    clearTimeout(timer);
    peer?.close();
    peer = null;
  }
  function wait(expiresAt) {
    stopCountdown();
    stopCountdown = countdown($('direct-expiry'), expiresAt, { prefix: 'Key expires in ' });
  }

  const sig = openSignaling(wsUrl(location), (msg) => {
    if (phase === 'done' || phase === 'failed') return;
    switch (msg.type) {
      case 'hosted': {
        live = { key: msg.key, liveToken: msg.liveToken, iceServers: msg.iceServers };
        phase = 'waiting';
        const url = shareUrl(msg.key);
        setText('direct-key', msg.key);
        $('direct-url').value = url;
        $('btn-direct-copy').onclick = () => copyText(url, $('direct-url'), $('direct-copy-status'));
        renderQr($('direct-qr'), url);
        wait(msg.expiresAt);
        status('Waiting for the receiver...');
        break;
      }
      case 'peer-joined':
        if (phase !== 'waiting') break;
        connect();
        break;
      case 'signal':
        peer?.handleSignal(msg.data);
        break;
      case 'peer-left':
        if (phase === 'uploading') break; // the upload goes on; the key stays reserved
        dropPeer();
        phase = 'waiting';
        $('direct-fallback').hidden = true;
        $('direct-progress').hidden = true;
        if (typeof msg.expiresAt === 'number') wait(msg.expiresAt);
        status('The receiver left. Waiting for the receiver...');
        break;
      case 'expired':
        if (phase === 'uploading') break; // a claimed key does not expire; complete decides
        fail('The key expired before anyone connected. Start again to get a new key.');
        break;
      case 'error':
        if (phase === 'uploading') break;
        fail(
          msg.code === 'rate_limited'
            ? 'Too many direct transfers from this network right now. Please try again later.'
            : 'Could not start a direct transfer.',
        );
        break;
      case 'closed':
        if (phase !== 'uploading') fail('Lost the connection to the server.');
        break;
    }
  });
  sig.sendWhenOpen({ type: 'host' });

  function connect() {
    phase = 'connecting';
    status('Receiver found. Connecting directly...');
    stopCountdown();
    setText('direct-expiry', '');
    const gen = ++generation;
    peer = createPeer({
      iceServers: live.iceServers,
      initiator: true,
      sendSignal: (data) => sig.send({ type: 'signal', data }),
      onChannel: (channel) => {
        channel.onopen = () => gen === generation && transfer(channel, gen);
      },
      onFailed: () => gen === generation && phase === 'connecting' && offerFallback(),
    });
    timer = setTimeout(() => phase === 'connecting' && offerFallback(), CONNECT_TIMEOUT_MS);
  }

  function offerFallback() {
    if (!mine()) return;
    $('direct-fallback').hidden = false;
    status('');
    $('btn-fallback').focus();
  }

  async function transfer(channel, gen) {
    clearTimeout(timer);
    phase = 'sending';
    $('direct-fallback').hidden = true;
    $('direct-progress').hidden = false;
    status('Sending...');
    try {
      await sendFiles(channel, files, onProgress);
    } catch {
      if (gen !== generation || phase !== 'sending') return; // receiver left: handled by peer-left
      return fail('The connection dropped before every file arrived. Please try again.');
    }
    if (gen !== generation) return;
    phase = 'done';
    status('All files were delivered.');
    $('direct-status').classList.add('ok');
    sig.close();
    setTimeout(() => peer?.close(), 1000); // let the ack's channel close cleanly
    $('direct-sender').hidden = true;
  }

  $('btn-fallback-wait').onclick = () => {
    $('direct-fallback').hidden = true;
    setText('direct-error', '');
    status('Still trying to connect directly...');
    clearTimeout(timer);
    timer = setTimeout(() => phase === 'connecting' && offerFallback(), CONNECT_TIMEOUT_MS);
  };

  // the socket stays open until complete returns: the server keeps the live key for us meanwhile
  $('btn-fallback').onclick = async () => {
    const problem = checkLimits(files, app.config);
    // too much to store: the direct session stays up and "Keep trying" is still offered
    if (problem) return setText('direct-error', problem);
    setText('direct-error', '');
    phase = 'uploading';
    dropPeer();
    $('direct-fallback').hidden = true;
    $('direct-progress').hidden = false;
    status('Uploading to the server instead...');
    const bar = progress('direct-bar', 'direct-progress-text', 'Uploaded');
    const onUpload = (sent, total) => mine() && bar(sent, total);
    try {
      const ready = await tracked(
        uploadTransfer(files, {
          liveKey: live.key,
          liveToken: live.liveToken,
          onProgress: onUpload,
          putChunk: xhrPutChunk,
        }),
      );
      phase = 'done';
      sig.close();
      clearSelectionOf(files);
      // the person moved on: the old direct view stays untouched, a notice carries the key
      if (!mine()) return notifyFinished(ready);
      showResult(ready);
    } catch (err) {
      if (!mine()) notifyFailed(err);
      fail(friendlyError(err));
    }
  };

  $('btn-direct-cancel').onclick = () => app.navigate('/');

  onLeave(() => {
    if (phase === 'uploading') return; // keep the socket: the upload in flight still needs it
    phase = phase === 'done' ? 'done' : 'failed';
    dropPeer();
    sig.close();
    stopCountdown();
    $('direct-status').classList.remove('ok');
  });
}
