// Types for direct.js, so TypeScript tests can import the plain JS module.

export type FileMeta = { name: string; size: number; mime: string };
export type ReceivedFile = FileMeta & { blob: Blob };

/** The parts of RTCDataChannel the protocol uses. */
export type ChannelLike = {
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: string | ArrayBuffer): void;
  addEventListener(type: string, fn: () => void, opts?: unknown): void;
  removeEventListener(type: string, fn: () => void): void;
};

export const CHUNK_BYTES: number;
export const BUFFER_HIGH: number;
export function encodeHeader(meta: { name: string; size: number; mime?: string }): string;
export function decodeHeader(buf: string | ArrayBuffer | ArrayBufferView): FileMeta;
export function sendFiles(
  channel: ChannelLike,
  files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>,
  onProgress?: (sent: number, total: number) => void,
): Promise<void>;
export function receiveFiles(
  channel: ChannelLike,
  onFile?: (file: ReceivedFile) => void,
  onProgress?: (received: number, total: number) => void,
): Promise<ReceivedFile[]>;
export function wsUrl(loc: { protocol: string; host: string }): string;
export function openSignaling(
  url: string,
  onMessage: (msg: { type: string; [k: string]: unknown }) => void,
  WS?: unknown,
): {
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  send(msg: object): void;
  sendWhenOpen(msg: object): void;
  close(): void;
};
export function createPeer(opts: {
  iceServers?: unknown[];
  initiator: boolean;
  sendSignal: (data: unknown) => void;
  onChannel: (channel: RTCDataChannel) => void;
  onFailed?: () => void;
  RTC?: unknown;
}): { handleSignal(data: unknown): Promise<void>; close(): void };
