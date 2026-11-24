const MAX_LENGTH = 200;

export function safeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return 'file';
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, MAX_LENGTH);
  return cleaned === '' ? 'file' : cleaned;
}
