import { randomInt } from 'node:crypto';

export const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_ATTEMPTS = 50;

export function generateKey(length: number, isTaken: (key: string) => boolean): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let key = '';
    for (let i = 0; i < length; i++) key += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
    if (!isTaken(key)) return key;
  }
  throw new Error('key space exhausted');
}

export function normalizeKey(input: unknown, length: number): string | null {
  if (typeof input !== 'string') return null;
  const key = input.replace(/[\s-]/g, '').toUpperCase();
  if (key.length !== length) return null;
  for (const ch of key) if (!KEY_ALPHABET.includes(ch)) return null;
  return key;
}
