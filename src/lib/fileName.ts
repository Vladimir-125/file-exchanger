const MAX_LENGTH = 200; // code points, so a surrogate pair is never split

// C0/C1 controls, bidi marks, embeddings, overrides and isolates (which can make
// `invoice‮fdp.exe` display as `invoiceexe.pdf`), and characters file systems refuse
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>:"/\\|?*]/g;

export function safeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return 'file';
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base.replace(UNSAFE, '_').replace(/^\.+/, ''))
    .slice(0, MAX_LENGTH)
    .join('');
  return cleaned.trim() === '' ? 'file' : cleaned;
}
