import type { CutRange, DetectParams } from './types.js';

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Find silent ranges in an RMS envelope.
 * A window is silent when its level is below `thresholdDb`. Runs of silent
 * windows at least `minDuration` long are silences; each is then shrunk by
 * `padding` on both sides so the cut leaves a little breathing room.
 */
export function detectSilences(
  rmsDb: ArrayLike<number>,
  rate: number,
  duration: number,
  params: DetectParams,
): TimeRange[] {
  const out: TimeRange[] = [];
  const n = rmsDb.length;
  const minWindows = Math.max(1, Math.round(params.minDuration * rate));
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const len = endIdx - runStart;
    if (len >= minWindows) {
      let start = runStart / rate + params.padding;
      let end = endIdx / rate - params.padding;
      // Silence touching the very start/end of the clip needs no padding on that side.
      if (runStart === 0) start = 0;
      if (endIdx >= n) end = duration;
      if (end - start > 0.02) out.push({ start, end: Math.min(end, duration) });
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    if (rmsDb[i] < params.thresholdDb) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i);
    }
  }
  flush(n);
  return out;
}

const overlap = (a: TimeRange, b: TimeRange) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * Turn detected silences into auto cut ranges for a clip, carrying over the
 * previous "keep" decisions for ranges that still overlap.
 */
export function buildAutoCuts(clipId: string, silences: TimeRange[], previous: CutRange[]): CutRange[] {
  const kept = previous.filter((c) => c.clipId === clipId && c.source === 'auto' && c.action === 'keep');
  return silences.map((s) => {
    const wasKept = kept.some((k) => {
      const ov = overlap(k, s);
      const smaller = Math.min(k.end - k.start, s.end - s.start);
      return smaller > 0 && ov / smaller >= 0.5;
    });
    return {
      id: `a:${clipId}:${Math.round(s.start * 1000)}`,
      clipId,
      start: s.start,
      end: s.end,
      source: 'auto',
      action: wasKept ? 'keep' : 'cut',
    };
  });
}
