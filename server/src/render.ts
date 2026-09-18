import fs from 'node:fs';
import path from 'node:path';
import { compileSegments, exportTarget, MUTE_DB, outputDuration, SPEED_MUTE_FROM, type ExportState, type ProjectFile, type Segment } from '@app/shared';
import { config, paths } from './config.js';
import { broadcast } from './events.js';
import { resolveProxyEncoder, runFfmpeg, videoEncoderArgs } from './ffmpeg.js';
import * as projects from './projects.js';

const running = new Map<string, AbortController>();

export const isExporting = (id: string) => running.has(id);

function setState(p: ProjectFile, patch: Partial<ExportState>): ExportState {
  p.export = { status: 'idle', progress: 0, ...(p.export ?? {}), ...patch };
  broadcast({ type: 'export:progress', projectId: p.id, export: p.export });
  return p.export;
}

/** The volume filter steps for a segment: an explicit mute, a gain in dB, or nothing. */
export function volumeFilters(seg: Pick<Segment, 'speed' | 'gainDb'>): string[] {
  if (seg.speed >= SPEED_MUTE_FROM) return ['volume=0'];
  const db = seg.gainDb ?? 0;
  if (db <= MUTE_DB) return ['volume=0'];
  if (Math.abs(db) < 0.01) return [];
  return [`volume=${db.toFixed(2)}dB`];
}

/** atempo only accepts 0.5..100 per instance in older builds; chain 2x steps to be safe. */
export function atempoChain(factor: number): string {
  const parts: string[] = [];
  let f = factor;
  while (f > 2) {
    parts.push('atempo=2');
    f /= 2;
  }
  parts.push(`atempo=${f}`);
  return parts.join(',');
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

/** Move a file or folder, falling back to copy + delete across drives. */
async function move(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.promises.cp(src, dest, { recursive: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

/** Move the originals of a project from the inbox to the done folder. */
async function moveToDone(p: ProjectFile): Promise<void> {
  if (p.location !== 'inbox') return;
  const src = path.join(config.inbox, p.sourcePath);
  if (!fs.existsSync(src)) throw new Error('source disappeared before it could be moved');
  const parsed = path.parse(p.sourcePath);
  const dest = p.kind === 'single' ? await uniquePath(config.done, parsed.name, parsed.ext) : await uniquePath(config.done, p.sourcePath, '');
  const destRel = path.relative(config.done, dest);
  // Switch the location first so the watcher's unlink event does not mark the project missing.
  const prev = { location: p.location, sourcePath: p.sourcePath };
  p.location = 'done';
  p.sourcePath = destRel;
  try {
    await move(src, dest);
  } catch (e) {
    Object.assign(p, prev);
    throw e;
  }
}

interface EncodeCtx {
  p: ProjectFile;
  encoder: string;
  target: { width: number; height: number; fps: number };
  tmpDir: string;
  signal: AbortSignal;
  total: number;
  report: (t: number) => void;
}

async function encodeSegment(ctx: EncodeCtx, seg: Segment, index: number): Promise<string> {
  const clip = ctx.p.clips.find((c) => c.id === seg.clipId)!;
  const src = projects.clipAbs(ctx.p, clip);
  const out = path.join(ctx.tmpDir, `seg-${String(index).padStart(4, '0')}.mov`);
  const { width, height, fps } = ctx.target;

  // Snap the segment to the source frame grid so the intermediate holds an exact number of frames
  // and its audio is exactly as long: joins are then seamless and A/V never drifts.
  const sfps = clip.fps > 0 ? clip.fps : fps;
  const f0 = Math.round(seg.srcStart * sfps);
  const f1 = Math.max(f0 + 1, Math.round(seg.srcEnd * sfps));
  const srcFrames = f1 - f0;
  const outFrames = Math.max(1, Math.round((srcFrames / seg.speed) * (fps / sfps)));
  const outLen = outFrames / fps;
  // Seek a fifth of a frame early so accurate seeking never drops the first wanted frame;
  // the audio is trimmed by the same amount so both streams start on that frame.
  const lead = 0.2 / sfps;
  const seekTo = Math.max(0, f0 / sfps - lead);
  const readLen = srcFrames / sfps + lead + 1 / sfps;

  const vf = [
    `setpts=(PTS-STARTPTS)/${seg.speed}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}:start_time=0:round=near`,
    'format=yuv420p',
  ].join(',');
  const af = [
    ...(seekTo > 0 ? [`atrim=start=${lead.toFixed(6)}`, 'asetpts=PTS-STARTPTS'] : []),
    ...(seg.speed !== 1 ? [atempoChain(seg.speed)] : []),
    ...volumeFilters(seg),
    'aresample=48000:first_pts=0',
  ].join(',');

  const inputs = [
    '-ss', seekTo.toFixed(6), '-t', readLen.toFixed(6), '-i', src,
    ...(clip.hasAudio ? [] : ['-f', 'lavfi', '-t', outLen.toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo']),
  ];
  const maps = clip.hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '1:a:0'];
  const args = [
    '-y',
    ...inputs,
    ...maps,
    '-vf', vf,
    ...(clip.hasAudio ? ['-af', af] : []),
    ...videoEncoderArgs(ctx.encoder, 'export'),
    '-video_track_timescale', '90000',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-sn', '-dn',
    '-t', outLen.toFixed(6),
    out,
  ];
  await runFfmpeg(args, {
    duration: outLen,
    signal: ctx.signal,
    onProgress: (frac) => ctx.report(seg.outStart + frac * outLen),
  });
  return out;
}

async function run(p: ProjectFile, controller: AbortController): Promise<void> {
  const signal = controller.signal;
  // Snapshot the edits: later autosaves must not affect a running export.
  const snapshot: ProjectFile = JSON.parse(JSON.stringify(p));
  const segments = compileSegments(snapshot);
  if (!segments.length) throw new Error('nothing to export: every part of the video is cut');
  const total = outputDuration(segments);
  const target = exportTarget(snapshot.clips, config.export);
  const encoder = config.export.encoder === 'auto' ? await resolveProxyEncoder() : config.export.encoder;

  const tmpDir = path.join(paths.tmp, `export-${p.id}`);
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });

  let lastSent = 0;
  const report = (t: number) => {
    const progress = Math.min(0.97, (t / total) * 0.97);
    const now = Date.now();
    if (now - lastSent < 300 && progress < 0.97) return;
    lastSent = now;
    setState(p, { progress, message: `encoding ${Math.round(progress * 100)}%` });
  };

  try {
    const ctx: EncodeCtx = { p: snapshot, encoder, target, tmpDir, signal, total, report };
    const parts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (signal.aborted) throw new Error('cancelled');
      setState(p, { message: `encoding segment ${i + 1} / ${segments.length}` });
      parts.push(await encodeSegment(ctx, segments[i], i));
    }

    const list = path.join(tmpDir, 'concat.txt');
    await fs.promises.writeFile(
      list,
      parts.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    );
    const outPath = await uniquePath(config.output, p.name, '.mp4');
    const tmpOut = path.join(tmpDir, 'final.mp4');
    setState(p, { progress: 0.97, message: 'joining segments' });
    await runFfmpeg(
      [
        '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', config.export.audioBitrate,
        '-movflags', '+faststart',
        tmpOut,
      ],
      { duration: total, signal, onProgress: (f) => setState(p, { progress: 0.97 + f * 0.03 }) },
    );
    await fs.promises.rename(tmpOut, outPath);

    setState(p, { message: 'moving originals to done' });
    await moveToDone(p);
    p.exportedAt = new Date().toISOString();
    setState(p, { status: 'done', progress: 1, message: undefined, outputPath: outPath, finishedAt: p.exportedAt });
    console.log(`[export] ${p.name} -> ${outPath} (${total.toFixed(1)} s, ${segments.length} segments)`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function startExport(p: ProjectFile): void {
  if (running.has(p.id)) throw new Error('export already running');
  if (p.location === 'missing') throw new Error('source files are missing');
  if (!p.clips.length || p.clips.some((c) => c.status !== 'ready')) throw new Error('clips are still processing');
  const controller = new AbortController();
  running.set(p.id, controller);
  setState(p, { status: 'running', progress: 0, message: 'starting', outputPath: undefined, startedAt: new Date().toISOString(), finishedAt: undefined });
  void projects.save(p);
  run(p, controller)
    .catch((e) => {
      const msg = (e as Error).message;
      if (controller.signal.aborted || msg === 'cancelled') setState(p, { status: 'cancelled', progress: 0, message: 'cancelled' });
      else {
        console.error(`[export] ${p.name} failed: ${msg}`);
        setState(p, { status: 'error', progress: 0, message: msg.slice(0, 600) });
      }
    })
    .finally(async () => {
      running.delete(p.id);
      await projects.save(p);
      broadcast({ type: 'project:update', project: p });
      broadcast({ type: 'projects:changed' });
    });
}

export function cancelExport(p: ProjectFile): boolean {
  const c = running.get(p.id);
  if (!c) return false;
  c.abort();
  return true;
}
