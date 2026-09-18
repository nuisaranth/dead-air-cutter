import type { Clip, CutRange, GainRange, ProjectFile, SpeedRange } from './types.js';
import type { TimeRange } from './silence.js';

export interface Segment {
  clipId: string;
  clipIndex: number;
  /** Clip-local source seconds. */
  srcStart: number;
  srcEnd: number;
  speed: number;
  /** Total audio gain in dB for this segment: clip gain plus any gain range. */
  gainDb: number;
  /** Output (rendered) timeline seconds. */
  outStart: number;
  outEnd: number;
}

const MIN_SEGMENT = 0.02;

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** All ranges removed from a clip: trims plus active cuts, merged. */
export function cutRangesForClip(clip: Clip, cuts: CutRange[]): TimeRange[] {
  const ranges: TimeRange[] = cuts
    .filter((c) => c.clipId === clip.id && c.action === 'cut')
    .map((c) => ({ start: c.start, end: c.end }));
  if (clip.trimStart > 0) ranges.push({ start: 0, end: clip.trimStart });
  if (clip.trimEnd > 0) ranges.push({ start: clip.duration - clip.trimEnd, end: clip.duration });
  return mergeRanges(ranges);
}

/** Complement of the cut ranges within [0, duration]. */
export function keptRangesForClip(clip: Clip, cuts: CutRange[]): TimeRange[] {
  const removed = cutRangesForClip(clip, cuts);
  const kept: TimeRange[] = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor > MIN_SEGMENT) kept.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (clip.duration - cursor > MIN_SEGMENT) kept.push({ start: cursor, end: clip.duration });
  return kept;
}

/** Ordered list of what actually plays/renders, with speed factors applied. */
export function compileSegments(project: Pick<ProjectFile, 'clips' | 'cuts' | 'speeds'> & { gains?: GainRange[] }): Segment[] {
  const segments: Segment[] = [];
  let out = 0;
  project.clips.forEach((clip, clipIndex) => {
    const speeds = project.speeds
      .filter((s) => s.clipId === clip.id && s.end > s.start)
      .sort((a, b) => a.start - b.start);
    const gains = (project.gains ?? [])
      .filter((g) => g.clipId === clip.id && g.end > g.start)
      .sort((a, b) => a.start - b.start);
    for (const kept of keptRangesForClip(clip, project.cuts)) {
      // Split the kept range wherever the speed or the gain changes.
      const points = new Set<number>([kept.start, kept.end]);
      for (const r of [...speeds, ...gains]) {
        if (r.start > kept.start && r.start < kept.end) points.add(r.start);
        if (r.end > kept.start && r.end < kept.end) points.add(r.end);
      }
      const sorted = [...points].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (b - a < MIN_SEGMENT) continue;
        const mid = (a + b) / 2;
        const speed = speeds.find((s) => mid >= s.start && mid < s.end)?.factor ?? 1;
        const gainDb = (clip.gainDb ?? 0) + (gains.find((g) => mid >= g.start && mid < g.end)?.db ?? 0);
        const len = (b - a) / speed;
        segments.push({ clipId: clip.id, clipIndex, srcStart: a, srcEnd: b, speed, gainDb, outStart: out, outEnd: out + len });
        out += len;
      }
    }
  });
  return segments;
}

/** True when the candidate does not overlap another gain range on the same clip. */
export function gainRangeFits(existing: GainRange[], candidate: GainRange): boolean {
  return !existing.some(
    (g) => g.id !== candidate.id && g.clipId === candidate.clipId && g.start < candidate.end && candidate.start < g.end,
  );
}

export function outputDuration(segments: Segment[]): number {
  return segments.length ? segments[segments.length - 1].outEnd : 0;
}

/** Start offset of each clip on the continuous source timeline. */
export function clipOffsets(clips: Clip[]): number[] {
  const offsets: number[] = [];
  let t = 0;
  for (const c of clips) {
    offsets.push(t);
    t += c.duration;
  }
  return offsets;
}

export function totalSourceDuration(clips: Clip[]): number {
  return clips.reduce((a, c) => a + c.duration, 0);
}

export interface ClipTime {
  clipIndex: number;
  clipId: string;
  time: number;
}

/** Map a global (continuous source timeline) time to a clip + local time. */
export function globalToClip(clips: Clip[], t: number): ClipTime | null {
  if (!clips.length) return null;
  const offsets = clipOffsets(clips);
  for (let i = clips.length - 1; i >= 0; i--) {
    if (t >= offsets[i]) {
      const local = Math.min(Math.max(0, t - offsets[i]), clips[i].duration);
      return { clipIndex: i, clipId: clips[i].id, time: local };
    }
  }
  return { clipIndex: 0, clipId: clips[0].id, time: 0 };
}

export function clipToGlobal(clips: Clip[], clipId: string, time: number): number {
  const offsets = clipOffsets(clips);
  const i = clips.findIndex((c) => c.id === clipId);
  return i < 0 ? time : offsets[i] + time;
}

/** Map a source-timeline global time to the output time (snapped into kept material). */
export function sourceToOutput(segments: Segment[], clips: Clip[], globalT: number): number {
  const ct = globalToClip(clips, globalT);
  if (!ct) return 0;
  for (const s of segments) {
    if (s.clipIndex !== ct.clipIndex) continue;
    if (ct.time < s.srcStart) return s.outStart;
    if (ct.time >= s.srcStart && ct.time <= s.srcEnd) return s.outStart + (ct.time - s.srcStart) / s.speed;
  }
  const next = segments.find((s) => s.clipIndex > ct.clipIndex);
  return next ? next.outStart : outputDuration(segments);
}

export function outputToSource(segments: Segment[], clips: Clip[], outT: number): number {
  for (const s of segments) {
    if (outT >= s.outStart && outT <= s.outEnd) {
      return clipToGlobal(clips, s.clipId, s.srcStart + (outT - s.outStart) * s.speed);
    }
  }
  const last = segments[segments.length - 1];
  return last ? clipToGlobal(clips, last.clipId, last.srcEnd) : 0;
}

/** True when `candidate` does not overlap another speed range on the same clip. */
export function speedRangeFits(existing: SpeedRange[], candidate: SpeedRange): boolean {
  return !existing.some(
    (s) => s.id !== candidate.id && s.clipId === candidate.clipId && s.start < candidate.end && candidate.start < s.end,
  );
}
