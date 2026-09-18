export * from './types.js';
export * from './silence.js';
export * from './segments.js';
export * from './naturalSort.js';

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mts', '.m2ts', '.wmv', '.flv', '.ts'];

export function isVideoFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('~')) return false;
  if (/\.(part|crdownload|tmp)$/.test(lower)) return false;
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function formatTime(seconds: number, showMs = false): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = showMs ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
}
export * from './exportTarget.js';
