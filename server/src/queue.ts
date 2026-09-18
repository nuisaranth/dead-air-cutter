import fs from 'node:fs';
import { buildAutoCuts, detectSilences, type Analysis, type Clip, type ClipStatus, type ProjectFile } from '@app/shared';
import { config, paths } from './config.js';
import { broadcast } from './events.js';
import { ENVELOPE_RATE, PEAKS_PER_SECOND, extractEnvelope, makeProxy, probe } from './ffmpeg.js';
import * as projects from './projects.js';

interface Job {
  projectId: string;
  clipId: string;
}

const pending: Job[] = [];
const active = new Set<string>();
let running = 0;

const key = (j: Job) => `${j.projectId}/${j.clipId}`;

function needsWork(clip: Clip): boolean {
  if (clip.status === 'error') return false;
  return clip.status !== 'ready' || clip.processedFingerprint !== clip.fingerprint || !clip.analysisReady || !clip.proxyReady;
}

export function enqueueProject(p: ProjectFile): void {
  if (p.location === 'missing') return;
  for (const clip of p.clips) {
    if (!needsWork(clip)) continue;
    const job = { projectId: p.id, clipId: clip.id };
    const k = key(job);
    if (active.has(k) || pending.some((j) => key(j) === k)) continue;
    pending.push(job);
  }
  pump();
}

/** Force a clip through the pipeline again (e.g. after a config change). */
export function reprocessProject(p: ProjectFile): void {
  for (const clip of p.clips) {
    Object.assign(clip, { status: 'pending', progress: 0, error: undefined, analysisReady: false, proxyReady: false });
  }
  enqueueProject(p);
}

function pump(): void {
  while (running < Math.max(1, config.concurrency) && pending.length) {
    const job = pending.shift()!;
    running++;
    active.add(key(job));
    processClip(job)
      .catch((e) => console.error('[queue] unexpected', e))
      .finally(() => {
        running--;
        active.delete(key(job));
        pump();
      });
  }
}

let lastProgressBroadcast = 0;

function setStatus(p: ProjectFile, clip: Clip, status: ClipStatus, progress: number, force = false): void {
  clip.status = status;
  clip.progress = progress;
  const now = Date.now();
  if (force || now - lastProgressBroadcast > 250) {
    lastProgressBroadcast = now;
    broadcast({ type: 'clip:progress', projectId: p.id, clipId: clip.id, status, progress });
  }
}

async function processClip(job: Job): Promise<void> {
  const p = projects.get(job.projectId);
  const clip = p?.clips.find((c) => c.id === job.clipId);
  if (!p || !clip || p.location === 'missing') return;
  const fingerprint = clip.fingerprint;
  const file = projects.clipAbs(p, clip);
  console.log(`[queue] ${p.name} / ${clip.file}: start`);
  try {
    setStatus(p, clip, 'probing', 0, true);
    const info = await probe(file);
    if (!info.hasVideo) throw new Error('no video stream');
    Object.assign(clip, { duration: info.duration, fps: info.fps, width: info.width, height: info.height, hasAudio: info.hasAudio });

    // 1. Audio analysis (envelope + peaks), used for detection and the waveform.
    const analysisFile = paths.analysisFile(clip.id);
    const analysisUpToDate = clip.analysisReady && clip.processedFingerprint === fingerprint && fs.existsSync(analysisFile);
    if (!analysisUpToDate) {
      setStatus(p, clip, 'analyzing', 0, true);
      const env = info.hasAudio
        ? await extractEnvelope(file, info.duration, (pr) => setStatus(p, clip, 'analyzing', pr))
        : { rmsDb: [], peaks: [] };
      const analysis: Analysis = {
        version: 1,
        clipId: clip.id,
        duration: info.duration,
        rate: ENVELOPE_RATE,
        rmsDb: env.rmsDb,
        peaksPerSecond: PEAKS_PER_SECOND,
        peaks: env.peaks,
      };
      await fs.promises.writeFile(analysisFile, JSON.stringify(analysis));
      clip.analysisReady = true;
      // Pre-detect with the project's current params so the queue shows a cut count
      // and the editor opens with cuts already marked.
      p.cuts = p.cuts.filter((c) => !(c.clipId === clip.id && c.source === 'auto'));
      if (info.hasAudio) {
        const silences = detectSilences(env.rmsDb, ENVELOPE_RATE, info.duration, p.params);
        p.cuts.push(...buildAutoCuts(clip.id, silences, []));
      }
      await projects.save(p);
    }

    // 2. Low-res proxy for preview.
    const proxyFile = paths.proxyFile(clip.id);
    const proxyUpToDate = clip.proxyReady && clip.processedFingerprint === fingerprint && fs.existsSync(proxyFile);
    if (!proxyUpToDate) {
      setStatus(p, clip, 'proxying', 0, true);
      await makeProxy(file, proxyFile, {
        height: config.proxy.height,
        sourceHeight: info.height,
        hasAudio: info.hasAudio,
        duration: info.duration,
        onProgress: (pr) => setStatus(p, clip, 'proxying', pr),
      });
      clip.proxyReady = true;
    }

    clip.processedFingerprint = fingerprint;
    clip.error = undefined;
    setStatus(p, clip, 'ready', 1, true);
    console.log(`[queue] ${p.name} / ${clip.file}: ready`);
  } catch (e) {
    clip.error = (e as Error).message;
    setStatus(p, clip, 'error', 0, true);
    console.error(`[queue] ${p.name} / ${clip.file}: ${clip.error}`);
  }
  await projects.save(p);
  broadcast({ type: 'project:update', project: p });
  // The source was replaced while we were working on it: go again.
  if (clip.fingerprint !== fingerprint && clip.status !== 'error') {
    clip.status = 'pending';
    enqueueProject(p);
  }
}
