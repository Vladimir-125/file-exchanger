import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { HttpError } from '../errors.ts';
import { decryptStream } from '../lib/crypto.ts';

/** One zip entry; `open` is called only when the archive is ready for it, so one file is open at a time. */
export type ZipEntry = { name: string; open: () => Promise<Readable> };

const missing = () => new HttpError(404, 'not_found', 'File not found');

/** Opens a stored file: plain bytes, or decrypted with `fileKey`. A missing file is 404. */
export async function openStored(filePath: string, fileKey: Buffer | null): Promise<Readable> {
  try {
    if (fileKey) return await decryptStream(filePath, fileKey);
    const fh = await fs.open(filePath, 'r');
    return fh.createReadStream(); // closes the handle on end or destroy
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
    throw err;
  }
}

/** Makes display names unique (case-insensitively): `a.txt`, `a (2).txt`, `a (3).txt`. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * Streams a stored (uncompressed) zip of `entries`, appending them one at a time. Any entry
 * error aborts the archive and destroys the returned stream with that error, so a broken zip
 * never ends cleanly.
 */
export function zipStream(entries: ZipEntry[]): Readable {
  const archive = new ZipArchive({ store: true });
  let current: Readable | undefined;
  let failed = false;
  const fail = (err: Error) => {
    if (failed) return;
    failed = true;
    current?.destroy();
    archive.abort(); // abort() alone ends the stream normally: destroy with the error as well
    archive.destroy(err);
  };
  archive.on('error', fail);

  const appendOne = (name: string, src: Readable) =>
    new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        archive.off('entry', onEntry);
        archive.off('close', onClose);
        src.off('error', done);
        if (err) reject(err);
        else resolve();
      };
      const onEntry = () => done();
      const onClose = () => done(new Error('archive closed'));
      archive.once('entry', onEntry);
      archive.once('close', onClose); // the client went away
      src.once('error', done);
      archive.append(src, { name });
    });

  (async () => {
    for (const entry of entries) {
      if (failed || archive.destroyed) return;
      current = await entry.open();
      if (failed || archive.destroyed) return void current.destroy();
      await appendOne(entry.name, current);
      current = undefined;
    }
    await archive.finalize();
  })().catch(fail);

  return archive;
}
