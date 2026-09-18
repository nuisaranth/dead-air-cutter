// Shared types used by both server and client.

export interface DetectParams {
  /** Windows with RMS below this level (dBFS) count as silent. */
  thresholdDb: number;
  /** Minimum length (seconds) of a silent run to be considered a silence. */
  minDuration: number;
  /** Seconds of silence kept on each side of a cut so speech is not clipped. */
  padding: number;
}

export type ClipStatus = 'pending' | 'probing' | 'analyzing' | 'proxying' | 'ready' | 'error';

export interface Clip {
  id: string;
  /** File name relative to the project's source path (single-clip: the file itself). */
  file: string;
  /** size:mtime of the source, used to detect replaced files. */
  fingerprint: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Seconds trimmed from the head / tail of this clip. */
  trimStart: number;
  trimEnd: number;
  /** Gain in dB applied to this whole clip, before any GainRange. */
  gainDb: number;
  status: ClipStatus;
  progress: number;
  error?: string;
  analysisReady: boolean;
  proxyReady: boolean;
  /** Fingerprint the analysis/proxy were generated from. */
  processedFingerprint?: string;
}

export interface CutRange {
  id: string;
  clipId: string;
  /** Clip-local source seconds. */
  start: number;
  end: number;
  source: 'auto' | 'manual';
  action: 'cut' | 'keep';
}

export type SpeedFactor = 2 | 4 | 8 | 16;

/** Ranges at or above this speed are muted: speech through atempo is unintelligible chirping by then. */
export const SPEED_MUTE_FROM = 16;

/** At or below this level a gain range is treated as a hard mute (volume=0). */
export const MUTE_DB = -60;

/** Range the gain UI offers. */
export const GAIN_MIN_DB = MUTE_DB;
export const GAIN_MAX_DB = 12;

/** dBFS -> linear multiplier; anything at MUTE_DB or below collapses to silence. */
export function dbToLinear(db: number): number {
  return db <= MUTE_DB ? 0 : 10 ** (db / 20);
}

/** The gain choices the UI offers, quietest first. */
export const GAIN_STEPS: readonly number[] = [MUTE_DB, -12, -6, -3, 0, 3, 6, 12];

export function gainLabel(db: number): string {
  if (db <= MUTE_DB) return 'mute';
  if (Math.abs(db) < 0.01) return '0 dB';
  return (db > 0 ? '+' : '') + Math.round(db * 10) / 10 + ' dB';
}

/** Label for a whole-clip volume, spelled out so a muted or boosted clip is obvious at a glance. */
export function clipGainLabel(db: number): string {
  if (db <= MUTE_DB) return 'MUTED';
  if (Math.abs(db) < 0.01) return 'vol 0 dB';
  return 'vol ' + gainLabel(db);
}

export interface SpeedRange {
  id: string;
  clipId: string;
  start: number;
  end: number;
  factor: SpeedFactor;
}

/** A span whose audio is amplified, attenuated or muted. Video is untouched. */
export interface GainRange {
  id: string;
  clipId: string;
  start: number;
  end: number;
  /** Gain in dB on top of the clip gain; MUTE_DB or lower = silence. */
  db: number;
}

export type ProjectLocation = 'inbox' | 'done' | 'missing';

export type ExportStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface ExportState {
  status: ExportStatus;
  progress: number;
  message?: string;
  outputPath?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProjectFile {
  version: 1;
  id: string;
  name: string;
  kind: 'single' | 'multi';
  /** Path relative to the inbox (or done) folder: a file for single, a folder for multi. */
  sourcePath: string;
  location: ProjectLocation;
  clips: Clip[];
  params: DetectParams;
  cuts: CutRange[];
  speeds: SpeedRange[];
  gains: GainRange[];
  createdAt: string;
  updatedAt: string;
  exportedAt?: string;
  export?: ExportState;
}

/** The subset of a project the client may change. */
export interface ProjectEdits {
  params: DetectParams;
  cuts: CutRange[];
  speeds: SpeedRange[];
  gains: GainRange[];
  /** Order of this array is the clip order. */
  clips: { id: string; trimStart: number; trimEnd: number; gainDb: number }[];
}

export type ProjectStatus = 'queued' | 'processing' | 'ready' | 'error' | 'missing';

export interface ProjectSummary {
  id: string;
  name: string;
  kind: 'single' | 'multi';
  location: ProjectLocation;
  status: ProjectStatus;
  progress: number;
  clipCount: number;
  totalDuration: number;
  cutCount: number;
  updatedAt: string;
  exportedAt?: string;
  export?: ExportState;
}

/** Per-clip audio analysis produced by the server. */
export interface Analysis {
  version: 1;
  clipId: string;
  duration: number;
  /** RMS level in dBFS per window, `rate` windows per second, values in [-100, 0]. */
  rate: number;
  rmsDb: number[];
  /** Waveform peaks (max abs amplitude 0..1), `peaksPerSecond` per second. */
  peaksPerSecond: number;
  peaks: number[];
}

export type ServerEvent =
  | { type: 'projects:changed' }
  | { type: 'project:update'; project: ProjectFile }
  | { type: 'clip:progress'; projectId: string; clipId: string; status: ClipStatus; progress: number }
  | { type: 'export:progress'; projectId: string; export: ExportState };

export interface AppConfigPublic {
  inbox: string;
  output: string;
  done: string;
  defaults: DetectParams;
  export: { resolution: 'auto' | string; fps: 'auto' | number; crf: number; preset: string; encoder: string; audioFormat: string };
}
