// Direct transfers: the data-channel file protocol, plus small WebRTC and signaling helpers.
// Pure: browser globals (WebSocket, RTCPeerConnection) are only looked up inside functions, so
// this module also loads in Node for tests.
//
// Protocol on one ordered RTCDataChannel (text frames are JSON):
//   sender:   {t:'manifest', count, total}
//             then per file: header {t:'file', name, size, mime}, binary chunks (64 KB), {t:'end'}
//             then {t:'done'}
//   receiver: {t:'ack'} once every file has arrived

export const CHUNK_BYTES = 64 * 1024;
export const BUFFER_HIGH = 1024 * 1024; // pause sending above this, resume on bufferedamountlow
const READ_BYTES = 16 * CHUNK_BYTES; // read the file in larger blocks than it is sent

export function encodeHeader({ name, size, mime }) {
  return JSON.stringify({ t: 'file', name, size, mime: mime || '' });
}

/** Parses a header frame (string or bytes); throws on anything else. */
export function decodeHeader(buf) {
  const text = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
  const h = JSON.parse(text);
  if (!h || h.t !== 'file' || typeof h.name !== 'string' || !Number.isSafeInteger(h.size) || h.size < 0) {
    throw new Error('Bad file header');
  }
  return { name: h.name, size: h.size, mime: typeof h.mime === 'string' ? h.mime : '' };
}

function control(data) {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

const closed = () => new Error('The connection closed before the transfer finished');

/** Resolves once the channel's buffer drains below its low threshold. */
function drained(channel) {
  return new Promise((resolve, reject) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', fail);
      resolve();
    };
    const fail = () => {
      channel.removeEventListener('bufferedamountlow', done);
      reject(closed());
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', fail, { once: true });
  });
}

/**
 * Sends `files` over an open data channel. Resolves when the receiver acknowledges every file.
 * onProgress(sent, total) counts bytes handed to the channel.
 */
export async function sendFiles(channel, files, onProgress = () => {}) {
  const list = Array.from(files);
  const total = list.reduce((sum, f) => sum + f.size, 0);
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = BUFFER_HIGH;
  const acked = new Promise((resolve, reject) => {
    channel.onmessage = (e) => {
      if (control(e.data)?.t === 'ack') resolve();
    };
    channel.addEventListener('close', () => reject(closed()), { once: true });
  });
  acked.catch(() => {}); // a close while still sending is reported by the send loop instead

  let sent = 0;
  onProgress(0, total);
  channel.send(JSON.stringify({ t: 'manifest', count: list.length, total }));
  for (const file of list) {
    channel.send(encodeHeader({ name: file.name, size: file.size, mime: file.type }));
    for (let offset = 0; offset < file.size; offset += READ_BYTES) {
      const block = await file.slice(offset, offset + READ_BYTES).arrayBuffer();
      for (let at = 0; at < block.byteLength; at += CHUNK_BYTES) {
        if (channel.bufferedAmount > BUFFER_HIGH) await drained(channel);
        const piece = block.slice(at, at + CHUNK_BYTES);
        channel.send(piece);
        sent += piece.byteLength;
        onProgress(sent, total);
      }
    }
    channel.send(JSON.stringify({ t: 'end' }));
  }
  channel.send(JSON.stringify({ t: 'done' }));
  await acked;
}

/**
 * Receives files from the channel. onFile({ name, size, mime, blob }) runs as each file completes;
 * onProgress(received, total). Resolves with every file once the sender is done.
 */
export function receiveFiles(channel, onFile = () => {}, onProgress = () => {}) {
  channel.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const files = [];
    let total = 0;
    let received = 0;
    let current = null; // { meta, parts, bytes }
    let finished = false;
    const fail = (err) => {
      finished = true;
      channel.onmessage = null;
      reject(err);
    };
    channel.addEventListener('close', () => finished || fail(closed()), { once: true });
    channel.onmessage = (e) => {
      if (finished) return;
      try {
        if (typeof e.data !== 'string') {
          const bytes = e.data.byteLength;
          if (!current || current.bytes + bytes > current.meta.size) throw new Error('Unexpected file data');
          current.parts.push(e.data);
          current.bytes += bytes;
          received += bytes;
          onProgress(received, total);
          return;
        }
        const msg = control(e.data);
        if (msg?.t === 'manifest') {
          total = Number(msg.total) || 0;
          onProgress(0, total);
        } else if (msg?.t === 'file') {
          if (current) throw new Error('Unexpected file header');
          current = { meta: decodeHeader(e.data), parts: [], bytes: 0 };
        } else if (msg?.t === 'end') {
          if (!current || current.bytes !== current.meta.size) throw new Error('A file arrived incomplete');
          const { name, size, mime } = current.meta;
          const file = { name, size, mime, blob: new Blob(current.parts, { type: mime }) };
          current = null;
          files.push(file);
          onFile(file);
        } else if (msg?.t === 'done') {
          if (current) throw new Error('A file arrived incomplete');
          finished = true;
          channel.send(JSON.stringify({ t: 'ack' }));
          resolve(files);
        }
      } catch (err) {
        fail(err);
      }
    };
  });
}

/** The signaling endpoint for a page location. */
export function wsUrl(loc) {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/**
 * Opens the signaling socket. `onMessage` (replaceable later through the returned handle's
 * `onMessage`) gets every server message, then `{type:'closed'}` once when the socket ends,
 * including when it never opened. Nothing is delivered after close().
 */
export function openSignaling(url, onMessage, WS = globalThis.WebSocket) {
  const ws = new WS(url);
  let ended = false;
  const handle = {
    onMessage,
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    /** Sends once the socket is open. */
    sendWhenOpen(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      else ws.addEventListener('open', () => ws.send(JSON.stringify(msg)), { once: true });
    },
    close() {
      ended = true;
      ws.close();
    },
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!ended && msg && typeof msg.type === 'string') handle.onMessage(msg);
  };
  ws.onclose = () => {
    if (ended) return;
    ended = true;
    handle.onMessage({ type: 'closed' });
  };
  return handle;
}

/**
 * One WebRTC peer connection carrying a single ordered data channel. The initiator (sender) makes
 * the channel and the offer; the other side gets the channel through onChannel.
 * Feed every relayed `signal` payload to handleSignal.
 */
export function createPeer({ iceServers, initiator, sendSignal, onChannel, onFailed = () => {}, RTC }) {
  const Peer = RTC ?? globalThis.RTCPeerConnection;
  const pc = new Peer({ iceServers: iceServers ?? [] });
  const pending = []; // candidates that arrived before the remote description
  let chain = Promise.resolve();

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') onFailed();
  };

  if (initiator) {
    const channel = pc.createDataChannel('files', { ordered: true });
    onChannel(channel);
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ description: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
    }).catch(() => onFailed());
  } else {
    pc.ondatachannel = (e) => onChannel(e.channel);
  }

  async function apply(data) {
    if (data && data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal({ description: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription });
      }
      while (pending.length) await pc.addIceCandidate(pending.shift());
    } else if (data && data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pending.push(data.candidate);
    }
  }

  return {
    handleSignal(data) {
      chain = chain.then(() => apply(data)).catch(() => onFailed());
      return chain;
    },
    close() {
      try {
        pc.close();
      } catch {
        // already closed
      }
    },
  };
}
