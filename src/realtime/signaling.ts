import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import proxyAddr from 'proxy-addr';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { WINDOWS } from '../middleware/rateLimits.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { generateKey, normalizeKey } from '../lib/keys.ts';

const PATH = '/ws';
const MAX_PAYLOAD = 64 * 1024;
const SWEEP_MS = 5_000;
const HEARTBEAT_MS = 30_000;

type Room = {
  key: string;
  sender: WebSocket;
  receiver?: WebSocket;
  tokenHash: string;
  /**
   * Deadline for a receiver to arrive. It only counts while nobody is paired: a paired room (a
   * direct transfer or its fallback upload in progress) ends only through a disconnect,
   * notifyStored or close(). It restarts when the receiver leaves.
   */
  expiresAt: number;
  bound: boolean; // claimed by a fallback upload: no longer expires
};

type Peer = { ip: string; alive: boolean; role?: 'sender' | 'receiver'; room?: Room };

type Msg = { type: string; key?: unknown; data?: unknown };

export type SignalingHub = ReturnType<typeof createSignaling>;

/** The same trust rules Express applies for `trust proxy`, so the hub sees the IP req.ip would. */
function compileTrust(val: Config['trustProxy']): (addr: string, i: number) => boolean {
  if (val === true) return () => true;
  if (typeof val === 'number') return (_addr, i) => i < val;
  if (typeof val === 'string') return proxyAddr.compile(val.split(',').map((s) => s.trim()));
  return proxyAddr.compile([]);
}

/** Sliding-window counter per client IP. */
function slidingWindow(now: () => number, windowMs: number, limit: number) {
  const hits = new Map<string, number[]>();
  const recent = (ip: string) => {
    const t = now();
    const times = (hits.get(ip) ?? []).filter((x) => x > t - windowMs);
    if (times.length) hits.set(ip, times);
    else hits.delete(ip);
    return times;
  };
  return {
    full: (ip: string) => recent(ip).length >= limit,
    hit(ip: string) {
      hits.set(ip, [...recent(ip), now()]);
    },
    prune() {
      for (const ip of [...hits.keys()]) recent(ip);
    },
  };
}

function parse(data: RawData, isBinary: boolean): Msg | null {
  if (isBinary) return null;
  try {
    const msg: unknown = JSON.parse(String(data));
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
    return typeof (msg as Msg).type === 'string' ? (msg as Msg) : null;
  } catch {
    return null;
  }
}

/**
 * WebSocket hub for direct transfers: pairs a sender and a receiver on a live key and relays
 * their WebRTC signals verbatim. Holds no file data.
 *
 * A room lives exactly as long as its sender's socket: a sender doing a fallback upload must keep
 * the socket open until `complete` returns, or the key is freed and the upload gets a new one.
 */
export function createSignaling({
  config,
  now,
  isStoredKey,
  rateLimitPerHour,
  joinMissPerWindow,
  heartbeatMs = HEARTBEAT_MS,
}: {
  config: Config;
  now: () => number;
  isStoredKey: (key: string) => boolean;
  /** `host` messages per client IP per `WINDOWS.ws` window (1 h). */
  rateLimitPerHour: number;
  /** `not-found`/`not-live` join replies per client IP per `WINDOWS.miss` window, like the HTTP miss limiter. */
  joinMissPerWindow: number;
  heartbeatMs?: number;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const rooms = new Map<string, Room>();
  const peers = new Map<WebSocket, Peer>();
  const hostLimit = slidingWindow(now, WINDOWS.ws.windowMs, rateLimitPerHour);
  const joinMisses = slidingWindow(now, WINDOWS.miss.windowMs, joinMissPerWindow); // stops key guessing
  const trust = compileTrust(config.trustProxy);
  const attached = new Set<http.Server>();

  const send = (ws: WebSocket | undefined, msg: object) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  /** Forgets a room and detaches both sockets from it without telling anyone. */
  function free(room: Room) {
    if (rooms.get(room.key) === room) rooms.delete(room.key);
    for (const ws of [room.sender, room.receiver]) {
      const peer = ws && peers.get(ws);
      if (peer?.room === room) {
        peer.room = undefined;
        peer.role = undefined;
      }
    }
  }

  /** Ends a room: each side gets its last message (if any), then both sockets close. */
  function endRoom(room: Room, toSender: object | null, toReceiver: object) {
    free(room);
    if (toSender) send(room.sender, toSender);
    send(room.receiver, toReceiver);
    room.sender.close(1000);
    room.receiver?.close(1000);
  }

  function sweep() {
    const t = now();
    for (const room of [...rooms.values()]) {
      if (!room.bound && !room.receiver && t >= room.expiresAt) endRoom(room, { type: 'expired' }, { type: 'expired' });
    }
    hostLimit.prune();
    joinMisses.prune();
  }

  /** The room this key names, if the token is its sender's. */
  function ownedRoom(key: string, liveToken: string): Room | undefined {
    const room = rooms.get(key);
    if (!room) return undefined;
    const a = Buffer.from(sha256Hex(liveToken));
    const b = Buffer.from(room.tokenHash);
    return timingSafeEqual(a, b) ? room : undefined; // both are sha256 hex: equal length
  }

  function onHost(ws: WebSocket, peer: Peer) {
    if (peer.role) return send(ws, { type: 'error', code: 'bad_state' });
    if (hostLimit.full(peer.ip)) return send(ws, { type: 'error', code: 'rate_limited' });
    hostLimit.hit(peer.ip);
    const key = generateKey(config.keyLength, (k) => rooms.has(k) || isStoredKey(k));
    const liveToken = randomToken();
    const room: Room = {
      key,
      sender: ws,
      tokenHash: sha256Hex(liveToken),
      expiresAt: now() + config.liveKeyTtlMs,
      bound: false,
    };
    rooms.set(key, room);
    peer.role = 'sender';
    peer.room = room;
    send(ws, { type: 'hosted', key, liveToken, expiresAt: room.expiresAt, iceServers: config.iceServers });
  }

  function onJoin(ws: WebSocket, peer: Peer, input: unknown) {
    if (peer.role) return send(ws, { type: 'error', code: 'bad_state' });
    if (joinMisses.full(peer.ip)) {
      send(ws, { type: 'error', code: 'rate_limited' });
      return ws.close(1008);
    }
    const key = normalizeKey(input, config.keyLength);
    const room = key ? rooms.get(key) : undefined;
    if (!room) {
      joinMisses.hit(peer.ip);
      return send(ws, { type: key && isStoredKey(key) ? 'not-live' : 'not-found' });
    }
    if (room.receiver) return send(ws, { type: 'busy' });
    room.receiver = ws;
    peer.role = 'receiver';
    peer.room = room;
    send(ws, { type: 'joined', iceServers: config.iceServers });
    send(room.sender, { type: 'peer-joined' });
  }

  function onSignal(ws: WebSocket, peer: Peer, data: unknown) {
    const room = peer.room;
    if (!room?.receiver) return; // not paired: dropped
    send(ws === room.sender ? room.receiver : room.sender, { type: 'signal', data });
  }

  function onLeave(ws: WebSocket) {
    const peer = peers.get(ws);
    peers.delete(ws);
    const room = peer?.room;
    if (!room) return;
    if (room.sender === ws) {
      free(room);
      send(room.receiver, { type: 'peer-left' });
    } else {
      room.receiver = undefined;
      room.expiresAt = now() + config.liveKeyTtlMs; // waiting for a new receiver again
      send(room.sender, { type: 'peer-left', expiresAt: room.expiresAt });
    }
  }

  function onConnection(ws: WebSocket, req: http.IncomingMessage) {
    const peer: Peer = { ip: proxyAddr(req, trust), alive: true };
    peers.set(ws, peer);
    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      sweep();
      if (ws.readyState !== ws.OPEN) return; // closing: ended by this sweep or earlier
      const msg = parse(data, isBinary);
      if (msg?.type === 'host') onHost(ws, peer);
      else if (msg?.type === 'join') onJoin(ws, peer, msg.key);
      else if (msg?.type === 'signal') onSignal(ws, peer, msg.data);
      else send(ws, { type: 'error', code: 'bad_message' });
    });
    ws.on('error', () => ws.terminate()); // e.g. an oversized frame; 'close' follows
    ws.on('close', () => onLeave(ws));
  }

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    let pathname: string | undefined;
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      // unparseable: refused below
    }
    if (pathname !== PATH) return socket.destroy();
    socket.on('error', () => socket.destroy());
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  }

  const sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref();
  // dead connections (a phone that went offline) never send close: they free their key here
  const heartbeat = setInterval(() => {
    for (const [ws, peer] of peers) {
      if (!peer.alive) {
        ws.terminate();
        continue;
      }
      peer.alive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    attach(server: http.Server): void {
      attached.add(server);
      server.on('upgrade', onUpgrade);
    },

    isLive(key: string): boolean {
      return rooms.has(key);
    },

    /** True when the key is live and the token is its sender's; the key then no longer expires. */
    claimLiveKey(key: string, liveToken: string): boolean {
      const room = ownedRoom(key, liveToken);
      if (room) room.bound = true;
      return room !== undefined;
    },

    /** Undoes a claim whose upload failed: the key can expire again. */
    releaseClaim(key: string, liveToken: string): void {
      const room = ownedRoom(key, liveToken);
      if (room) room.bound = false;
    },

    /** The live key now names a stored transfer: the receiver switches to a normal download. */
    notifyStored(key: string): void {
      const room = rooms.get(key);
      if (room) endRoom(room, null, { type: 'switch-to-download', key });
    },

    sweep,

    close(): void {
      clearInterval(sweepTimer);
      clearInterval(heartbeat);
      for (const server of attached) server.off('upgrade', onUpgrade);
      attached.clear();
      for (const ws of peers.keys()) ws.terminate();
      rooms.clear();
      wss.close();
    },
  };
}
