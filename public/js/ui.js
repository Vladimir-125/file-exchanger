// DOM helpers shared by the views. User-supplied text only ever goes through textContent.

import { formatBytes } from './upload.js';

export const $ = (id) => document.getElementById(id);

/** Creates an element. `props` are DOM properties, except `aria-*`/`data-*` which become attributes. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('aria-') || k.startsWith('data-')) node.setAttribute(k, String(v));
    else node[k] = v;
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function setText(id, text) {
  $(id).textContent = text ?? '';
}

let leaving = [];

/** Runs `fn` when the current view is left (timers, sockets, object URLs). */
export function onLeave(fn) {
  leaving.push(fn);
}

const TABS = { send: 'send', result: 'send', receive: 'receive', direct: null, account: 'account' };

/** Shows one view, hides the rest and runs the previous view's cleanups. */
export function showView(name) {
  const cleanups = leaving;
  leaving = [];
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // a failed cleanup must not block navigation
    }
  }
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.dataset.tab === TABS[name]) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} d ${hr} h`;
  if (hr > 0) return `${hr} h ${min} min`;
  if (min > 0) return `${min} min ${sec} s`;
  return `${sec} s`;
}

/** Keeps `node` showing the time left until `expiresAt`; stops when the view is left. */
export function countdown(node, expiresAt, { prefix = 'Expires in ', onExpire } = {}) {
  let timer;
  const tick = () => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      node.textContent = 'Expired';
      clearInterval(timer);
      onExpire?.();
      return;
    }
    node.textContent = `${prefix}${formatDuration(left)}`;
  };
  timer = setInterval(tick, 1000);
  tick();
  const stop = () => clearInterval(timer);
  onLeave(stop);
  return stop;
}

/** A file list row: name, size, then any extra nodes (links, buttons). */
export function fileRow(name, size, ...extra) {
  return h('li', {}, h('span', { className: 'name' }, name), h('span', { className: 'size' }, formatBytes(size)), ...extra);
}

/** Returns a setter for a <progress> + text pair. */
export function progress(barId, textId, verb) {
  const bar = $(barId);
  const text = $(textId);
  return (done, total) => {
    bar.max = Math.max(total, 1);
    bar.value = total === 0 ? 1 : done;
    const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
    text.textContent = `${verb} ${formatBytes(done)} of ${formatBytes(total)} (${pct}%)`;
  };
}

/** Copies text to the clipboard; without clipboard access it selects the input so people can copy it. */
export async function copyText(text, input, statusNode) {
  try {
    await navigator.clipboard.writeText(text);
    statusNode.textContent = 'Link copied.';
  } catch {
    input.focus();
    input.select();
    statusNode.textContent = 'Press Ctrl+C (or long-press) to copy the selected link.';
  }
}
