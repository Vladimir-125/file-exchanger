// Types for upload.js, so TypeScript tests can import the plain JS module.

export type Chunk = { index: number; start: number; end: number };
export type PublicFile = { fileId: string; name: string; size: number };
export type ReadyTransfer = { key: string; url: string; expiresAt: number; protected: boolean; files: PublicFile[] };
export type Limits = { maxFileBytes: number; maxFilesPerTransfer: number; maxTransferBytes: number };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type PutChunk = (url: string, blob: Blob, token: string, onBytes: (n: number) => void) => Promise<unknown>;

export type UploadOptions = {
  password?: string;
  liveKey?: string;
  liveToken?: string;
  onProgress?: (sent: number, total: number) => void;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  putChunk?: PutChunk;
};

export function planChunks(size: number, chunkBytes: number): Chunk[];
export function formatBytes(n: number): string;
export function checkLimits(files: ArrayLike<{ name: string; size: number }>, limits: Limits): string | null;
export function isRetryable(err: unknown): boolean;
export function xhrPutChunk(url: string, blob: Blob, token: string, onBytes: (n: number) => void, stallMs?: number): Promise<unknown>;
export function uploadTransfer(files: ArrayLike<File> | Iterable<File>, opts?: UploadOptions): Promise<ReadyTransfer>;
