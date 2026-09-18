import type { Clip } from './types.js';

export interface ExportTarget {
  width: number;
  height: number;
  fps: number;
}

export interface ExportPrefs {
  /** 'auto' = largest clip resolution, or "WxH". */
  resolution?: 'auto' | string;
  /** 'auto' = highest clip fps. */
  fps?: 'auto' | number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output resolution / fps for a project: largest clip (by pixel count) and highest fps, unless overridden. */
export function exportTarget(clips: Clip[], prefs: ExportPrefs = {}): ExportTarget {
  let width = 0;
  let height = 0;
  let fps = 0;
  for (const c of clips) {
    if (c.width * c.height > width * height) {
      width = c.width;
      height = c.height;
    }
    if (c.fps > fps) fps = c.fps;
  }
  if (prefs.resolution && prefs.resolution !== 'auto') {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(prefs.resolution.trim());
    if (m) {
      width = Number(m[1]);
      height = Number(m[2]);
    }
  }
  if (typeof prefs.fps === 'number' && prefs.fps > 0) fps = prefs.fps;
  if (!width || !height) {
    width = 1280;
    height = 720;
  }
  if (!fps) fps = 30;
  // Round odd frame rates (29.97 -> keep as is; ffmpeg accepts decimals) but keep sane bounds.
  fps = Math.min(120, Math.max(1, Math.round(fps * 1000) / 1000));
  return { width: even(width), height: even(height), fps };
}
