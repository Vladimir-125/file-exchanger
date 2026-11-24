// Chunked upload to the server: create -> chunks (sequential, retried) -> complete.
// Pure: no DOM or browser globals at import time, so tests can load it in Node.

import { ApiError, errorFrom, request } from './api.js';

const BACKOFF_MS = [1000, 2000, 4000];
const CHUNK_TIMEOUT_MS = 120_000; // a stalled chunk PUT fails and is retried
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

/** Byte ranges for a file of `size` bytes; empty for an empty file. */
export function planChunks(size, chunkBytes) {
  const chunks = [];
  for (let index = 0, start = 0; start < size; index++, start += chunkBytes) {
    chunks.push({ index, start, end: Math.min(start + chunkBytes, size) });
  }
  return chunks;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** The first problem with this selection under the server's limits, or null when it fits. */
export function checkLimits(files, { maxFileBytes, maxFilesPerTransfer, maxTransferBytes }) {
  if (files.length === 0) return 'Choose at least one file.';
  if (files.length > maxFilesPerTransfer) return `You can send up to ${maxFilesPerTransfer} files at once.`;
  const big = files.find((f) => f.size > maxFileBytes);
  if (big) return `"${big.name}" is larger than the ${formatBytes(maxFileBytes)} limit per file.`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > maxTransferBytes) return `The files together are larger than the ${formatBytes(maxTransferBytes)} limit.`;
  return null;
}

/** Whether a failed chunk is worth sending again: network errors, 5xx, 408 and 429. */
export function isRetryable(err) {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429;
}

/** Default chunk transport: fetch, so progress moves once per chunk. */
function fetchPut(fetchImpl) {
  return (url, blob, token) =>
    request(url, { method: 'PUT', body: blob, headers: { 'x-upload-token': token }, fetch: fetchImpl });
}

/**
 * Browser chunk transport with byte-level progress. XMLHttpRequest is looked up only when called.
 * `onBytes(n)` reports how much of this chunk has been sent so far.
 */
export function xhrPutChunk(url, blob, token, onBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-upload-token', token);
    xhr.timeout = CHUNK_TIMEOUT_MS;
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', 'The upload stalled. Check your connection.'));
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Could not reach the server. Check your connection.'));
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(null);
      reject(await errorFrom(new Response(xhr.responseText, { status: xhr.status })));
    };
    xhr.send(blob);
  });
}

/**
 * Uploads `files` as one transfer and returns the ReadyTransfer from `complete`.
 * opts: password, liveKey + liveToken (fallback for a direct transfer), onProgress(sent, total),
 * and for tests or the browser: fetch, sleep, putChunk(url, blob, token, onBytes).
 */
export async function uploadTransfer(files, opts = {}) {
  const { password, liveKey, liveToken, onProgress = () => {}, fetch, sleep = defaultSleep } = opts;
  const putChunk = opts.putChunk ?? fetchPut(fetch);
  const list = Array.from(files);
  const total = list.reduce((sum, f) => sum + f.size, 0);

  const created = await request('/api/transfers', {
    method: 'POST',
    json: {
      files: list.map((f) => ({ name: f.name, size: f.size, ...(f.type ? { mime: f.type } : {}) })),
      ...(password ? { password } : {}),
    },
    fetch,
  });
  const { transferId, uploadToken, chunkBytes } = created;

  let done = 0;
  onProgress(0, total);
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const { fileId } = created.files[i];
    for (const { index, start, end } of planChunks(file.size, chunkBytes)) {
      const url = `/api/transfers/${enc(transferId)}/files/${enc(fileId)}/chunks/${index}`;
      const blob = file.slice(start, end);
      for (let attempt = 0; ; attempt++) {
        try {
          await putChunk(url, blob, uploadToken, (n) => onProgress(done + Math.min(n, end - start), total));
          break;
        } catch (err) {
          if (attempt >= BACKOFF_MS.length || !isRetryable(err)) throw err;
          onProgress(done, total);
          await sleep(BACKOFF_MS[attempt]);
        }
      }
      done += end - start;
      onProgress(done, total);
    }
  }

  return request(`/api/transfers/${enc(transferId)}/complete`, {
    method: 'POST',
    headers: { 'x-upload-token': uploadToken },
    json: liveKey && liveToken ? { liveKey, liveToken } : {},
    fetch,
  });
}
