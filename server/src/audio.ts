import fs from 'node:fs';
import path from 'node:path';
import { compileSegments, outputDuration, type ProjectFile, type Segment } from '@app/shared';
import { config, paths } from './config.js';
import { runFfmpeg } from './ffmpeg.js';
import * as projects from './projects.js';
import { atempoChain, volumeFilters } from './render.js';

export interface AudioExportResult {
  path: string;
  duration: number;
  segments: number;
  /** True when only part of the timeline was rendered. */
  partial: boolean;
}

/** A window on the OUTPUT (rendered) timeline, in seconds. */
export interface OutRange {
  start: number;
  end: number;
}

/**
 * Keep only the parts of the timeline inside the window, re-cutting the segments that straddle
 * its edges and rebasing the output times so the result starts at zero.
 */
function clampToRange(segments: Segment[], range: OutRange): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const t0 = Math.max(seg.outStart, range.start);
    const t1 = Math.min(seg.outEnd, range.end);
    if (t1 - t0 < 0.02) continue;
    // Output seconds map back to source seconds through the segment's speed factor.
    const srcStart = seg.srcStart + (t0 - seg.outStart) * seg.speed;
    const srcEnd = seg.srcStart + (t1 - seg.outStart) * seg.speed;
    const len = t1 - t0;
    out.push({ ...seg, srcStart, srcEnd, outStart: cursor, outEnd: cursor + len });
    cursor += len;
  }
  return out;
}

/** Codec + extension for the configured audio format. */
function codecArgs(format: string): { ext: string; args: string[] } {
  switch (format.toLowerCase()) {
    case 'mp3':
      return { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', config.export.audioBitrate] };
    case 'm4a':
    case 'aac':
      return { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', config.export.audioBitrate, '-movflags', '+faststart'] };
    case 'flac':
      return { ext: '.flac', args: ['-c:a', 'flac'] };
    default:
      return { ext: '.wav', args: ['-c:a', 'pcm_s16le'] };
  }
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

/**
 * Encode one segment's audio to an intermediate wav. Mirrors `encodeSegment` in render.ts
 * (same frame-grid snapping, same lead trim, same atempo/volume chain) minus every video step,
 * so the result stays sample-aligned with the mp4 export.
 */
async function encodeSegment(p: ProjectFile, seg: Segment, index: number, tmpDir: string, signal: AbortSignal): Promise<string> {
  const clip = p.clips.find((c) => c.id === seg.clipId)!;
  const src = projects.clipAbs(p, clip);
  const out = path.join(tmpDir, `seg-${String(index).padStart(4, '0')}.wav`);

  const sfps = clip.fps > 0 ? clip.fps : 30;
  const f0 = Math.round(seg.srcStart * sfps);
  const f1 = Math.max(f0 + 1, Math.round(seg.srcEnd * sfps));
  const srcFrames = f1 - f0;
  const outLen = srcFrames / sfps / seg.speed;
  const lead = 0.2 / sfps;
  const seekTo = Math.max(0, f0 / sfps - lead);
  const readLen = srcFrames / sfps + lead + 1 / sfps;

  const af = [
    ...(seekTo > 0 ? [`atrim=start=${lead.toFixed(6)}`, 'asetpts=PTS-STARTPTS'] : []),
    ...(seg.speed !== 1 ? [atempoChain(seg.speed)] : []),
    ...volumeFilters(seg),
    'aresample=48000:first_pts=0',
  ].join(',');

  const args = clip.hasAudio
    ? ['-y', '-ss', seekTo.toFixed(6), '-t', readLen.toFixed(6), '-i', src, '-map', '0:a:0', '-af', af, '-vn', '-sn', '-dn']
    : ['-y', '-f', 'lavfi', '-t', outLen.toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:a:0'];

  await runFfmpeg([...args, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', outLen.toFixed(6), out], {
    duration: outLen,
    signal,
  });
  return out;
}

/**
 * Render the edited soundtrack on its own: the same cuts, clip order, speed ramps and gains as the
 * video export, with no video encoding at all. Nothing is moved and the project state is untouched.
 */
export async function exportAudio(p: ProjectFile, range?: OutRange): Promise<AudioExportResult> {
  if (p.location === 'missing') throw new Error('source files are missing');
  if (!p.clips.length || p.clips.some((c) => c.status !== 'ready')) throw new Error('clips are still processing');
  const all = compileSegments(p);
  if (!all.length) throw new Error('nothing to export: every part of the video is cut');
  const partial = !!range && range.end - range.start > 0.02;
  const segments = partial ? clampToRange(all, range!) : all;
  if (!segments.length) throw new Error('the selected range contains nothing but cuts');
  const total = outputDuration(segments);
  const { ext, args: codec } = codecArgs(config.export.audioFormat);

  const tmpDir = path.join(paths.tmp, `audio-${p.id}`);
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const controller = new AbortController();

  try {
    const parts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      parts.push(await encodeSegment(p, segments[i], i, tmpDir, controller.signal));
    }
    const list = path.join(tmpDir, 'concat.txt');
    await fs.promises.writeFile(
      list,
      parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    );
    const outPath = await uniquePath(config.output, partial ? p.name + ' selection' : p.name, ext);
    const tmpOut = path.join(tmpDir, `final${ext}`);
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:a:0', ...codec, tmpOut], { duration: total });
    await fs.promises.rename(tmpOut, outPath);
    console.log(`[audio] ${p.name} -> ${outPath} (${total.toFixed(1)} s, ${segments.length} segments${partial ? ', selection' : ''})`);
    return { path: outPath, duration: total, segments: segments.length, partial };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
