import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GAIN_MAX_DB, GAIN_MIN_DB, naturalSort, type Clip, type ProjectEdits, type ProjectFile, type ProjectSummary } from '@app/shared';
import { config, paths } from './config.js';
import { broadcast } from './events.js';

const store = new Map<string, ProjectFile>();

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();

export const projectIdFor = (sourcePath: string) => sha1(normalize(sourcePath)).slice(0, 10);
export const clipIdFor = (projectId: string, file: string) => `${projectId}-${sha1(normalize(file)).slice(0, 8)}`;

export async function loadAll(): Promise<void> {
  const files = await fs.promises.readdir(paths.projects).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(await fs.promises.readFile(path.join(paths.projects, f), 'utf8')) as ProjectFile;
      // Fields added after this file may have been written (phase 5: audio gain).
      if (!Array.isArray(p.gains)) p.gains = [];
      // A server restart interrupts any running job; those clips are re-queued by the watcher scan.
      for (const c of p.clips) {
        if (typeof c.gainDb !== 'number') c.gainDb = 0;
        if (c.status !== 'ready' && c.status !== 'error') c.status = 'pending';
      }
      if (p.export?.status === 'running') p.export = { status: 'error', progress: 0, message: 'server restarted' };
      store.set(p.id, p);
    } catch (e) {
      console.warn(`[projects] could not load ${f}: ${(e as Error).message}`);
    }
  }
  console.log(`[projects] loaded ${store.size} project(s)`);
}

export const all = (): ProjectFile[] => [...store.values()];
export const get = (id: string): ProjectFile | undefined => store.get(id);

export function baseDir(p: ProjectFile): string {
  return p.location === 'done' ? config.done : config.inbox;
}
export function sourceAbs(p: ProjectFile): string {
  return path.join(baseDir(p), p.sourcePath);
}
export function clipAbs(p: ProjectFile, clip: Clip): string {
  return p.kind === 'single' ? sourceAbs(p) : path.join(sourceAbs(p), clip.file);
}

export async function save(p: ProjectFile): Promise<void> {
  p.updatedAt = new Date().toISOString();
  const file = paths.projectFile(p.id);
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.promises.rename(tmp, file);
}

export interface ScanFile {
  name: string;
  size: number;
  mtimeMs: number;
}

const fingerprintOf = (f: ScanFile) => `${f.size}:${Math.round(f.mtimeMs)}`;

function newClip(projectId: string, f: ScanFile): Clip {
  return {
    id: clipIdFor(projectId, f.name),
    file: f.name,
    fingerprint: fingerprintOf(f),
    duration: 0,
    fps: 0,
    width: 0,
    height: 0,
    hasAudio: false,
    trimStart: 0,
    trimEnd: 0,
    gainDb: 0,
    status: 'pending',
    progress: 0,
    analysisReady: false,
    proxyReady: false,
  };
}

/**
 * A file that was moved (e.g. from the inbox root into a folder) keeps its size and mtime, so its
 * fingerprint matches a clip of another project. Reuse that clip's analysis, proxy and edits
 * instead of processing it again.
 */
async function adoptFromDonor(p: ProjectFile, clip: Clip): Promise<boolean> {
  for (const other of store.values()) {
    if (other.id === p.id) continue;
    const donor = other.clips.find(
      (c) => c.id !== clip.id && c.fingerprint === clip.fingerprint && c.processedFingerprint === c.fingerprint && c.status === 'ready' && c.analysisReady && c.proxyReady,
    );
    if (!donor) continue;
    const srcAnalysis = paths.analysisFile(donor.id);
    const srcProxy = paths.proxyFile(donor.id);
    if (!fs.existsSync(srcAnalysis) || !fs.existsSync(srcProxy)) continue;
    try {
      const analysis = JSON.parse(await fs.promises.readFile(srcAnalysis, 'utf8'));
      analysis.clipId = clip.id;
      await fs.promises.writeFile(paths.analysisFile(clip.id), JSON.stringify(analysis));
      await fs.promises.copyFile(srcProxy, paths.proxyFile(clip.id));
    } catch (e) {
      console.warn(`[projects] could not reuse ${donor.id} for ${clip.id}: ${(e as Error).message}`);
      continue;
    }
    Object.assign(clip, {
      duration: donor.duration,
      fps: donor.fps,
      width: donor.width,
      height: donor.height,
      hasAudio: donor.hasAudio,
      trimStart: donor.trimStart,
      trimEnd: donor.trimEnd,
      gainDb: donor.gainDb ?? 0,
      status: 'ready',
      progress: 1,
      error: undefined,
      analysisReady: true,
      proxyReady: true,
      processedFingerprint: clip.fingerprint,
    });
    // Carry the edits over. Auto cut ids embed the clip id; manual/speed ids are random.
    const reId = (id: string) => (id.startsWith(`a:${donor.id}:`) ? `a:${clip.id}:${id.slice(donor.id.length + 3)}` : id);
    p.cuts = [...p.cuts.filter((c) => c.clipId !== clip.id), ...other.cuts.filter((c) => c.clipId === donor.id).map((c) => ({ ...c, id: reId(c.id), clipId: clip.id }))];
    p.speeds = [...p.speeds.filter((s) => s.clipId !== clip.id), ...other.speeds.filter((s) => s.clipId === donor.id).map((s) => ({ ...s, clipId: clip.id }))];
    p.gains = [...(p.gains ?? []).filter((g) => g.clipId !== clip.id), ...(other.gains ?? []).filter((g) => g.clipId === donor.id).map((g) => ({ ...g, clipId: clip.id }))];
    if (p.clips.every((c) => c.id === clip.id || c.status === 'pending')) p.params = { ...other.params };
    console.log(`[projects] ${p.name} / ${clip.file}: reused analysis, proxy and edits from "${other.name}"`);
    return true;
  }
  return false;
}

/** Create a project for a scanned source, or reconcile an existing one with the files now present. */
export async function upsertFromScan(sourcePath: string, kind: 'single' | 'multi', files: ScanFile[]): Promise<ProjectFile> {
  const id = projectIdFor(sourcePath);
  const sorted = naturalSort(files, (f) => f.name);
  const now = new Date().toISOString();
  let p = store.get(id);
  if (!p) {
    p = {
      version: 1,
      id,
      name: kind === 'single' ? path.parse(sourcePath).name : path.basename(sourcePath),
      kind,
      sourcePath,
      location: 'inbox',
      clips: sorted.map((f) => newClip(id, f)),
      params: { ...config.defaults },
      cuts: [],
      speeds: [],
      gains: [],
      createdAt: now,
      updatedAt: now,
    };
    store.set(id, p);
    for (const c of p.clips) await adoptFromDonor(p, c);
  } else {
    p.location = 'inbox';
    p.kind = kind;
    const seen = new Set<string>();
    for (const f of sorted) {
      const existing = p.clips.find((c) => normalize(c.file) === normalize(f.name));
      if (existing) {
        seen.add(existing.id);
        if (existing.fingerprint !== fingerprintOf(f)) {
          Object.assign(existing, { fingerprint: fingerprintOf(f), status: 'pending', progress: 0, error: undefined });
        }
      } else {
        const c = newClip(id, f);
        seen.add(c.id);
        p.clips.push(c);
        await adoptFromDonor(p, c);
      }
    }
    const removed = p.clips.filter((c) => !seen.has(c.id)).map((c) => c.id);
    if (removed.length) {
      p.clips = p.clips.filter((c) => seen.has(c.id));
      p.cuts = p.cuts.filter((c) => !removed.includes(c.clipId));
      p.speeds = p.speeds.filter((s) => !removed.includes(s.clipId));
      p.gains = (p.gains ?? []).filter((g) => !removed.includes(g.clipId));
    }
  }
  await save(p);
  broadcast({ type: 'projects:changed' });
  return p;
}

export async function remove(id: string): Promise<void> {
  store.delete(id);
  await fs.promises.rm(paths.projectFile(id), { force: true });
  broadcast({ type: 'projects:changed' });
}

/** Projects whose originals were deleted from the done folder become `missing` (so they can be removed from the list). */
export async function reconcileDone(): Promise<boolean> {
  let changed = false;
  for (const p of store.values()) {
    if (p.location === 'done' && !fs.existsSync(sourceAbs(p))) {
      p.location = 'missing';
      await save(p);
      changed = true;
    } else if (p.location === 'missing' && fs.existsSync(path.join(config.done, p.sourcePath))) {
      p.location = 'done';
      await save(p);
      changed = true;
    }
  }
  if (changed) broadcast({ type: 'projects:changed' });
  return changed;
}

export async function markMissing(sourcePath: string): Promise<void> {
  const p = store.get(projectIdFor(sourcePath));
  if (!p || p.location !== 'inbox') return;
  p.location = 'missing';
  await save(p);
  broadcast({ type: 'projects:changed' });
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export async function applyEdits(id: string, edits: ProjectEdits): Promise<ProjectFile> {
  const p = store.get(id);
  if (!p) throw new Error('project not found');
  const clipIds = new Set(p.clips.map((c) => c.id));
  p.params = {
    thresholdDb: num(edits.params?.thresholdDb, p.params.thresholdDb),
    minDuration: num(edits.params?.minDuration, p.params.minDuration),
    padding: num(edits.params?.padding, p.params.padding),
  };
  p.cuts = (edits.cuts ?? [])
    .filter((c) => clipIds.has(c.clipId))
    .map((c) => ({
      id: String(c.id),
      clipId: c.clipId,
      start: num(c.start),
      end: num(c.end),
      source: c.source === 'manual' ? 'manual' : 'auto',
      action: c.action === 'keep' ? 'keep' : 'cut',
    }));
  p.speeds = (edits.speeds ?? [])
    .filter((s) => clipIds.has(s.clipId))
    .map((s) => ({
      id: String(s.id),
      clipId: s.clipId,
      start: num(s.start),
      end: num(s.end),
      factor: s.factor === 4 ? 4 : s.factor === 8 ? 8 : s.factor === 16 ? 16 : 2,
    }));
  p.gains = (edits.gains ?? [])
    .filter((g) => clipIds.has(g.clipId))
    .map((g) => ({
      id: String(g.id),
      clipId: g.clipId,
      start: num(g.start),
      end: num(g.end),
      db: Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, num(g.db))),
    }));
  if (Array.isArray(edits.clips)) {
    const order = edits.clips.map((c) => c.id).filter((cid) => clipIds.has(cid));
    const byId = new Map(p.clips.map((c) => [c.id, c]));
    const reordered = [...order.map((cid) => byId.get(cid)!), ...p.clips.filter((c) => !order.includes(c.id))];
    for (const e of edits.clips) {
      const c = byId.get(e.id);
      if (!c) continue;
      c.trimStart = Math.max(0, Math.min(c.duration, num(e.trimStart)));
      c.trimEnd = Math.max(0, Math.min(c.duration - c.trimStart, num(e.trimEnd)));
      c.gainDb = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, num(e.gainDb)));
    }
    p.clips = reordered;
  }
  await save(p);
  broadcast({ type: 'projects:changed' });
  return p;
}

export function summary(p: ProjectFile): ProjectSummary {
  let status: ProjectSummary['status'];
  if (p.location === 'missing') status = 'missing';
  else if (p.clips.some((c) => c.status === 'error')) status = 'error';
  else if (p.clips.length && p.clips.every((c) => c.status === 'ready')) status = 'ready';
  else if (p.clips.some((c) => c.status !== 'pending')) status = 'processing';
  else status = 'queued';
  const progress = p.clips.length
    ? p.clips.reduce((a, c) => a + (c.status === 'ready' ? 1 : c.progress), 0) / p.clips.length
    : 0;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    location: p.location,
    status,
    progress,
    clipCount: p.clips.length,
    totalDuration: p.clips.reduce((a, c) => a + c.duration, 0),
    cutCount: p.cuts.filter((c) => c.action === 'cut').length,
    updatedAt: p.updatedAt,
    exportedAt: p.exportedAt,
    export: p.export,
  };
}
