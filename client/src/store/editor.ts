import { create } from 'zustand';
import {
  buildAutoCuts,
  clipOffsets,
  detectSilences,
  globalToClip,
  shortId,
  speedRangeFits,
  totalSourceDuration,
  type Analysis,
  type Clip,
  type CutRange,
  type DetectParams,
  type ProjectEdits,
  type ProjectFile,
  type ServerEvent,
  type SpeedFactor,
  type GainRange,
  type SpeedRange,
} from '@app/shared';
import { api } from '../api';

export interface TimeSelection {
  /** Global source-timeline seconds. */
  start: number;
  end: number;
}

export interface GlobalCut extends CutRange {
  gStart: number;
  gEnd: number;
}

type Snapshot = ProjectEdits;

interface CommitOptions {
  /** Consecutive commits with the same key within 1 s share one undo step (slider drags). */
  coalesce?: string;
  /** Skip the undo stack (automatic bookkeeping like initial detection). */
  silent?: boolean;
}

/** Seconds of context played before/after a cut in review mode. */
export const REVIEW_CONTEXT = 1.5;

export interface EditorState {
  projectId: string | null;
  project: ProjectFile | null;
  analyses: Record<string, Analysis>;
  loading: boolean;
  error: string | null;
  past: Snapshot[];
  future: Snapshot[];
  selection: TimeSelection | null;
  selectedId: string | null;
  playhead: number;
  seekNonce: number;
  playing: boolean;
  /** Global time at which playback stops automatically (review "play around"). */
  stopAt: number | null;
  reviewMode: boolean;

  open(id: string): Promise<void>;
  close(): void;
  handleEvent(e: ServerEvent): void;
  commit(mutator: (p: ProjectFile) => void, opts?: CommitOptions): void;
  setParams(patch: Partial<DetectParams>): void;
  setCutAction(id: string, action: 'cut' | 'keep'): void;
  toggleCut(id: string): void;
  /** Bulk-mark all active cuts shorter than `maxDuration` seconds as kept (natural speech pauses). */
  keepShortCuts(maxDuration: number): void;
  /** Mark every detected silence as cut. */
  cutAll(): void;
  /** Mark every detected silence as kept (nothing removed). */
  keepAll(): void;
  addManualCut(clipId: string, start: number, end: number): string;
  removeRange(id: string): void;
  moveRange(id: string, start: number, end: number): void;
  setSpeed(clipId: string, start: number, end: number, factor: SpeedFactor): void;
  setSpeedFactor(id: string, factor: SpeedFactor): void;
  clearSpeed(clipId: string, start: number, end: number): void;
  /** Audio gain in dB: for a whole clip, and ranges layered on top (MUTE_DB = silence). */
  setClipGain(clipId: string, db: number): void;
  setGain(clipId: string, start: number, end: number, db: number): void;
  setGainDb(id: string, db: number): void;
  clearGain(clipId: string, start: number, end: number): void;
  setTrim(clipId: string, patch: { trimStart?: number; trimEnd?: number }): void;
  trimAtPlayhead(edge: 'head' | 'tail'): void;
  reorderClips(ids: string[]): void;
  undo(): void;
  redo(): void;
  /** `keepStop` keeps a pending `stopAt` (used when playback hops to the next clip). */
  setPlayhead(t: number, seek?: boolean, keepStop?: boolean): void;
  nudge(seconds: number): void;
  setSelection(sel: TimeSelection | null): void;
  select(id: string | null): void;
  setPlaying(b: boolean): void;
  playRange(from: number, to: number): void;
  setReviewMode(b: boolean): void;
  /** Selection tools */
  cutSelection(): void;
  speedSelection(factor: SpeedFactor): void;
  resetSpeedSelection(): void;
  /** Gain on the selection, the selected gain range, or the selected cut / speed block. */
  gainSelection(db: number): void;
  resetGainSelection(): void;
  /** Review navigation */
  sortedCuts(): GlobalCut[];
  currentCut(): GlobalCut | null;
  jumpCut(dir: 1 | -1): GlobalCut | null;
  playAroundCut(id?: string): void;
  flushSave(): void;
  /** Current edits (for sending along with an export request). */
  getEdits(): ProjectEdits | null;
}

const editsOf = (p: ProjectFile): ProjectEdits => ({
  params: { ...p.params },
  cuts: p.cuts.map((c) => ({ ...c })),
  speeds: p.speeds.map((s) => ({ ...s })),
  gains: (p.gains ?? []).map((g) => ({ ...g })),
  clips: p.clips.map((c) => ({ id: c.id, trimStart: c.trimStart, trimEnd: c.trimEnd, gainDb: c.gainDb ?? 0 })),
});

function applySnapshot(p: ProjectFile, s: Snapshot): ProjectFile {
  const byId = new Map(p.clips.map((c) => [c.id, c]));
  const clips = [
    ...s.clips.filter((c) => byId.has(c.id)).map((c) => ({ ...byId.get(c.id)!, trimStart: c.trimStart, trimEnd: c.trimEnd, gainDb: c.gainDb ?? 0 })),
    ...p.clips.filter((c) => !s.clips.some((sc) => sc.id === c.id)),
  ];
  return { ...p, params: { ...s.params }, cuts: s.cuts.map((c) => ({ ...c })), speeds: s.speeds.map((x) => ({ ...x })), gains: (s.gains ?? []).map((g) => ({ ...g })), clips };
}

/** Recompute the auto cuts of one clip from its analysis, carrying over "keep" decisions. */
function redetectClip(p: ProjectFile, analysis: Analysis): void {
  const clip = p.clips.find((c) => c.id === analysis.clipId);
  if (!clip) return;
  const others = p.cuts.filter((c) => !(c.clipId === clip.id && c.source === 'auto'));
  const silences = clip.hasAudio ? detectSilences(analysis.rmsDb, analysis.rate, clip.duration, p.params) : [];
  p.cuts = [...others, ...buildAutoCuts(clip.id, silences, p.cuts)];
}

/** Split a global selection into per-clip local ranges. */
function selectionParts(clips: Clip[], sel: TimeSelection): { clipId: string; start: number; end: number }[] {
  const offsets = clipOffsets(clips);
  const parts: { clipId: string; start: number; end: number }[] = [];
  clips.forEach((clip, i) => {
    const s = Math.max(sel.start, offsets[i]);
    const e = Math.min(sel.end, offsets[i] + clip.duration);
    if (e - s > 0.02) parts.push({ clipId: clip.id, start: s - offsets[i], end: e - offsets[i] });
  });
  return parts;
}

/** Remove [start, end) of a clip from the gain ranges, splitting any that straddle it. */
function carveGains(gains: GainRange[], clipId: string, start: number, end: number): GainRange[] {
  const out: GainRange[] = [];
  for (const g of gains) {
    if (g.clipId !== clipId || g.end <= start || g.start >= end) {
      out.push(g);
      continue;
    }
    if (g.start < start) out.push({ ...g, id: 'g:' + shortId(), end: start });
    if (g.end > end) out.push({ ...g, id: 'g:' + shortId(), start: end });
  }
  return out;
}

function carve(speeds: SpeedRange[], clipId: string, start: number, end: number): SpeedRange[] {
  const out: SpeedRange[] = [];
  for (const sp of speeds) {
    if (sp.clipId !== clipId || sp.end <= start || sp.start >= end) {
      out.push(sp);
      continue;
    }
    if (sp.start < start) out.push({ ...sp, id: `s:${shortId()}`, end: start });
    if (sp.end > end) out.push({ ...sp, id: `s:${shortId()}`, start: end });
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: { id: string; edits: ProjectEdits } | null = null;
let lastCommit = { key: '', time: 0 };

function scheduleSave(p: ProjectFile): void {
  pendingSave = { id: p.id, edits: editsOf(p) };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600);
}

function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!pendingSave) return;
  const { id, edits } = pendingSave;
  pendingSave = null;
  api.saveEdits(id, edits).catch((e) => console.error('save failed', e));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!pendingSave) return;
    const { id, edits } = pendingSave;
    pendingSave = null;
    fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
      keepalive: true,
    }).catch(() => {});
  });
}

export const useEditor = create<EditorState>((set, get) => {
  /** Fetch analyses for clips that have one and are not loaded yet, then run detection where needed. */
  async function loadAnalyses(): Promise<void> {
    const { project, analyses } = get();
    if (!project) return;
    const missing = project.clips.filter((c) => c.analysisReady && !analyses[c.id]);
    if (!missing.length) return;
    const loaded = await Promise.all(missing.map((c) => api.analysis(c.id).catch(() => null)));
    const current = get();
    if (current.project?.id !== project.id) return;
    const next = { ...current.analyses };
    for (const a of loaded) if (a) next[a.clipId] = a;
    set({ analyses: next });
    const p = get().project!;
    const needs = loaded.filter((a): a is Analysis => !!a && !p.cuts.some((c) => c.clipId === a.clipId && c.source === 'auto'));
    if (needs.length) {
      get().commit(
        (draft) => {
          for (const a of needs) redetectClip(draft, a);
        },
        { silent: true },
      );
    }
  }

  const total = () => (get().project ? totalSourceDuration(get().project!.clips) : 0);

  return {
    projectId: null,
    project: null,
    analyses: {},
    loading: false,
    error: null,
    past: [],
    future: [],
    selection: null,
    selectedId: null,
    playhead: 0,
    seekNonce: 0,
    playing: false,
    stopAt: null,
    reviewMode: false,

    async open(id) {
      flush();
      set({
        projectId: id,
        project: null,
        analyses: {},
        loading: true,
        error: null,
        past: [],
        future: [],
        selection: null,
        selectedId: null,
        playhead: 0,
        playing: false,
        stopAt: null,
      });
      try {
        const project = await api.project(id);
        if (get().projectId !== id) return;
        set({ project, loading: false });
        await loadAnalyses();
      } catch (e) {
        set({ loading: false, error: (e as Error).message });
      }
    },

    close() {
      flush();
      set({ projectId: null, project: null, analyses: {}, past: [], future: [], selection: null, selectedId: null, playing: false, stopAt: null });
    },

    handleEvent(e) {
      const { project } = get();
      if (!project) return;
      if (e.type === 'clip:progress' && e.projectId === project.id) {
        set({
          project: {
            ...project,
            clips: project.clips.map((c) => (c.id === e.clipId ? { ...c, status: e.status, progress: e.progress } : c)),
          },
        });
      } else if (e.type === 'project:update' && e.project.id === project.id) {
        // Take the server's clip facts, keep our local edits.
        const serverClips = new Map(e.project.clips.map((c) => [c.id, c]));
        const clips: Clip[] = project.clips
          .filter((c) => serverClips.has(c.id))
          .map((c) => {
            const s = serverClips.get(c.id)!;
            return {
              ...c,
              status: s.status,
              progress: s.progress,
              error: s.error,
              duration: s.duration,
              fps: s.fps,
              width: s.width,
              height: s.height,
              hasAudio: s.hasAudio,
              analysisReady: s.analysisReady,
              proxyReady: s.proxyReady,
              fingerprint: s.fingerprint,
              processedFingerprint: s.processedFingerprint,
            };
          });
        for (const s of e.project.clips) if (!clips.some((c) => c.id === s.id)) clips.push({ ...s });
        const analyses = { ...get().analyses };
        for (const c of clips) {
          const old = project.clips.find((o) => o.id === c.id);
          if (old && old.processedFingerprint !== c.processedFingerprint) delete analyses[c.id];
        }
        set({ project: { ...project, clips, location: e.project.location, export: e.project.export, exportedAt: e.project.exportedAt }, analyses });
        void loadAnalyses();
      } else if (e.type === 'export:progress' && e.projectId === project.id) {
        set({ project: { ...project, export: e.export } });
      }
    },

    commit(mutator, opts = {}) {
      const { project, past } = get();
      if (!project) return;
      const before = editsOf(project);
      const draft: ProjectFile = {
        ...project,
        clips: project.clips.map((c) => ({ ...c })),
        cuts: [...project.cuts],
        speeds: [...project.speeds],
        gains: [...(project.gains ?? [])],
        params: { ...project.params },
      };
      mutator(draft);
      const now = Date.now();
      let nextPast = past;
      if (!opts.silent) {
        const coalesced = !!opts.coalesce && lastCommit.key === opts.coalesce && now - lastCommit.time < 1000;
        if (!coalesced) nextPast = [...past, before].slice(-200);
        lastCommit = { key: opts.coalesce ?? '', time: now };
      }
      set({ project: draft, past: nextPast, future: opts.silent ? get().future : [] });
      scheduleSave(draft);
    },

    setParams(patch) {
      const { analyses } = get();
      get().commit(
        (p) => {
          p.params = { ...p.params, ...patch };
          for (const a of Object.values(analyses)) redetectClip(p, a);
        },
        { coalesce: 'params' },
      );
    },

    setCutAction(id, action) {
      get().commit((p) => {
        p.cuts = p.cuts.map((c) => (c.id === id ? { ...c, action } : c));
      });
    },

    toggleCut(id) {
      const cut = get().project?.cuts.find((c) => c.id === id);
      if (cut) get().setCutAction(id, cut.action === 'cut' ? 'keep' : 'cut');
    },

    cutAll() {
      get().commit((p) => {
        p.cuts = p.cuts.map((c) => ({ ...c, action: 'cut' }));
      });
    },

    keepAll() {
      get().commit((p) => {
        p.cuts = p.cuts.map((c) => ({ ...c, action: 'keep' }));
      });
    },

    keepShortCuts(maxDuration) {
      get().commit((p) => {
        p.cuts = p.cuts.map((c) => (c.action === 'cut' && c.end - c.start < maxDuration ? { ...c, action: 'keep' } : c));
      });
    },

    addManualCut(clipId, start, end) {
      const id = `m:${shortId()}`;
      get().commit((p) => {
        const clip = p.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const s = Math.max(0, Math.min(start, end));
        const e = Math.min(clip.duration, Math.max(start, end));
        if (e - s < 0.02) return;
        const cut: CutRange = { id, clipId, start: s, end: e, source: 'manual', action: 'cut' };
        p.cuts = [...p.cuts, cut];
      });
      return id;
    },

    removeRange(id) {
      get().commit((p) => {
        const cut = p.cuts.find((c) => c.id === id);
        if (cut) {
          // Auto cuts are never deleted, only kept; manual ones go away.
          p.cuts = cut.source === 'manual' ? p.cuts.filter((c) => c.id !== id) : p.cuts.map((c) => (c.id === id ? { ...c, action: 'keep' } : c));
        }
        p.speeds = p.speeds.filter((s) => s.id !== id);
        p.gains = (p.gains ?? []).filter((g) => g.id !== id);
      });
      if (get().selectedId === id) set({ selectedId: null });
    },

    moveRange(id, start, end) {
      get().commit(
        (p) => {
          const clipOf = (clipId: string) => p.clips.find((c) => c.id === clipId);
          p.cuts = p.cuts.map((c) => {
            if (c.id !== id) return c;
            const d = clipOf(c.clipId)?.duration ?? end;
            return { ...c, start: Math.max(0, Math.min(start, end)), end: Math.min(d, Math.max(start, end)) };
          });
          p.speeds = p.speeds.map((s) => {
            if (s.id !== id) return s;
            const d = clipOf(s.clipId)?.duration ?? end;
            return { ...s, start: Math.max(0, Math.min(start, end)), end: Math.min(d, Math.max(start, end)) };
          });
          p.gains = (p.gains ?? []).map((g) => {
            if (g.id !== id) return g;
            const d = clipOf(g.clipId)?.duration ?? end;
            return { ...g, start: Math.max(0, Math.min(start, end)), end: Math.min(d, Math.max(start, end)) };
          });
        },
        { coalesce: `move:${id}` },
      );
    },

    setSpeed(clipId, start, end, factor) {
      get().commit((p) => {
        const clip = p.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const s = Math.max(0, Math.min(start, end));
        const e = Math.min(clip.duration, Math.max(start, end));
        if (e - s < 0.02) return;
        const carved = carve(p.speeds, clipId, s, e);
        const candidate: SpeedRange = { id: `s:${shortId()}`, clipId, start: s, end: e, factor };
        if (speedRangeFits(carved, candidate)) carved.push(candidate);
        p.speeds = carved;
      });
    },

    setSpeedFactor(id, factor) {
      get().commit((p) => {
        p.speeds = p.speeds.map((s) => (s.id === id ? { ...s, factor } : s));
      });
    },

    clearSpeed(clipId, start, end) {
      get().commit((p) => {
        p.speeds = carve(p.speeds, clipId, start, end);
      });
    },

    setClipGain(clipId, db) {
      get().commit((p) => {
        p.clips = p.clips.map((c) => (c.id === clipId ? { ...c, gainDb: db } : c));
      });
    },

    setGain(clipId, start, end, db) {
      get().commit((p) => {
        const clip = p.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const s = Math.max(0, Math.min(start, end));
        const e = Math.min(clip.duration, Math.max(start, end));
        if (e - s < 0.02) return;
        const carved = carveGains(p.gains ?? [], clipId, s, e);
        carved.push({ id: 'g:' + shortId(), clipId, start: s, end: e, db });
        p.gains = carved;
      });
    },

    setGainDb(id, db) {
      get().commit((p) => {
        p.gains = (p.gains ?? []).map((g) => (g.id === id ? { ...g, db } : g));
      });
    },

    clearGain(clipId, start, end) {
      get().commit((p) => {
        p.gains = carveGains(p.gains ?? [], clipId, start, end);
      });
    },

    setTrim(clipId, patch) {
      get().commit(
        (p) => {
          p.clips = p.clips.map((c) => {
            if (c.id !== clipId) return c;
            const trimStart = Math.max(0, Math.min(c.duration, patch.trimStart ?? c.trimStart));
            const trimEnd = Math.max(0, Math.min(c.duration - trimStart, patch.trimEnd ?? c.trimEnd));
            return { ...c, trimStart, trimEnd };
          });
        },
        { coalesce: `trim:${clipId}` },
      );
    },

    trimAtPlayhead(edge) {
      const { project, playhead } = get();
      if (!project) return;
      const ct = globalToClip(project.clips, playhead);
      if (!ct) return;
      const clip = project.clips[ct.clipIndex];
      if (edge === 'head') get().setTrim(clip.id, { trimStart: ct.time });
      else get().setTrim(clip.id, { trimEnd: clip.duration - ct.time });
    },

    reorderClips(ids) {
      get().commit((p) => {
        const byId = new Map(p.clips.map((c) => [c.id, c]));
        p.clips = [...ids.map((id) => byId.get(id)!).filter(Boolean), ...p.clips.filter((c) => !ids.includes(c.id))];
      });
    },

    undo() {
      const { project, past, future } = get();
      if (!project || !past.length) return;
      const snapshot = past[past.length - 1];
      const restored = applySnapshot(project, snapshot);
      set({ project: restored, past: past.slice(0, -1), future: [...future, editsOf(project)] });
      lastCommit = { key: '', time: 0 };
      scheduleSave(restored);
    },

    redo() {
      const { project, past, future } = get();
      if (!project || !future.length) return;
      const snapshot = future[future.length - 1];
      const restored = applySnapshot(project, snapshot);
      set({ project: restored, future: future.slice(0, -1), past: [...past, editsOf(project)] });
      lastCommit = { key: '', time: 0 };
      scheduleSave(restored);
    },

    setPlayhead(t, seek = false, keepStop = false) {
      const clamped = Math.max(0, Math.min(total(), t));
      if (!seek) set({ playhead: clamped });
      else set(keepStop ? { playhead: clamped, seekNonce: get().seekNonce + 1 } : { playhead: clamped, seekNonce: get().seekNonce + 1, stopAt: null });
    },

    nudge(seconds) {
      get().setPlayhead(get().playhead + seconds, true);
    },

    setSelection(selection) {
      set({ selection: selection && selection.end - selection.start > 0.02 ? selection : null });
    },
    select(selectedId) {
      set({ selectedId });
    },
    setPlaying(playing) {
      set(playing ? { playing } : { playing, stopAt: null });
    },
    playRange(from, to) {
      set({ playhead: Math.max(0, from), seekNonce: get().seekNonce + 1, stopAt: Math.min(total(), to), playing: true });
    },
    setReviewMode(reviewMode) {
      set({ reviewMode });
    },

    cutSelection() {
      const { project, selection } = get();
      if (!project || !selection) return;
      const parts = selectionParts(project.clips, selection);
      let lastId: string | null = null;
      get().commit((p) => {
        for (const part of parts) {
          lastId = `m:${shortId()}`;
          p.cuts = [...p.cuts, { id: lastId, clipId: part.clipId, start: part.start, end: part.end, source: 'manual', action: 'cut' }];
        }
      });
      set({ selection: null, selectedId: lastId });
    },

    speedSelection(factor) {
      const { project, selection, selectedId } = get();
      if (!project) return;
      if (selection) {
        const parts = selectionParts(project.clips, selection);
        get().commit((p) => {
          for (const part of parts) {
            const carved = carve(p.speeds, part.clipId, part.start, part.end);
            carved.push({ id: `s:${shortId()}`, clipId: part.clipId, start: part.start, end: part.end, factor });
            p.speeds = carved;
          }
        });
        set({ selection: null });
      } else if (selectedId && project.speeds.some((s) => s.id === selectedId)) {
        get().setSpeedFactor(selectedId, factor);
      } else if (selectedId) {
        // A selected cut / kept silence: speed up exactly that span and select the new range.
        const cut = project.cuts.find((c) => c.id === selectedId);
        if (!cut) return;
        const id = `s:${shortId()}`;
        get().commit((p) => {
          const carved = carve(p.speeds, cut.clipId, cut.start, cut.end);
          carved.push({ id, clipId: cut.clipId, start: cut.start, end: cut.end, factor });
          p.speeds = carved;
        });
        set({ selectedId: id });
      }
    },

    resetSpeedSelection() {
      const { project, selection, selectedId } = get();
      if (!project) return;
      if (selection) {
        const parts = selectionParts(project.clips, selection);
        get().commit((p) => {
          for (const part of parts) p.speeds = carve(p.speeds, part.clipId, part.start, part.end);
        });
        set({ selection: null });
      } else if (selectedId && project.speeds.some((s) => s.id === selectedId)) {
        get().removeRange(selectedId);
      } else if (selectedId) {
        const cut = project.cuts.find((c) => c.id === selectedId);
        if (cut) get().clearSpeed(cut.clipId, cut.start, cut.end);
      }
    },

    gainSelection(db) {
      const { project, selection, selectedId } = get();
      if (!project) return;
      if (selection) {
        const parts = selectionParts(project.clips, selection);
        let lastId: string | null = null;
        get().commit((p) => {
          for (const part of parts) {
            lastId = 'g:' + shortId();
            const carved = carveGains(p.gains ?? [], part.clipId, part.start, part.end);
            carved.push({ id: lastId, clipId: part.clipId, start: part.start, end: part.end, db });
            p.gains = carved;
          }
        });
        set({ selection: null, selectedId: lastId });
      } else if (selectedId && (project.gains ?? []).some((g) => g.id === selectedId)) {
        get().setGainDb(selectedId, db);
      } else if (selectedId) {
        // A selected cut / kept silence / speed range: apply the gain to exactly that span.
        const r = project.cuts.find((c) => c.id === selectedId) ?? project.speeds.find((s) => s.id === selectedId);
        if (!r) return;
        const id = 'g:' + shortId();
        get().commit((p) => {
          const carved = carveGains(p.gains ?? [], r.clipId, r.start, r.end);
          carved.push({ id, clipId: r.clipId, start: r.start, end: r.end, db });
          p.gains = carved;
        });
        set({ selectedId: id });
      }
    },

    resetGainSelection() {
      const { project, selection, selectedId } = get();
      if (!project) return;
      if (selection) {
        const parts = selectionParts(project.clips, selection);
        get().commit((p) => {
          for (const part of parts) p.gains = carveGains(p.gains ?? [], part.clipId, part.start, part.end);
        });
        set({ selection: null });
      } else if (selectedId && (project.gains ?? []).some((g) => g.id === selectedId)) {
        get().removeRange(selectedId);
      } else if (selectedId) {
        const r = project.cuts.find((c) => c.id === selectedId) ?? project.speeds.find((s) => s.id === selectedId);
        if (r) get().clearGain(r.clipId, r.start, r.end);
      }
    },

    sortedCuts() {
      const p = get().project;
      if (!p) return [];
      const offsets = clipOffsets(p.clips);
      const index = new Map(p.clips.map((c, i) => [c.id, i]));
      return p.cuts
        .map((c) => {
          const off = offsets[index.get(c.clipId) ?? 0] ?? 0;
          return { ...c, gStart: off + c.start, gEnd: off + c.end };
        })
        .sort((a, b) => a.gStart - b.gStart);
    },

    currentCut() {
      const { selectedId } = get();
      const cuts = get().sortedCuts();
      return cuts.find((c) => c.id === selectedId) ?? null;
    },

    jumpCut(dir) {
      const cuts = get().sortedCuts();
      if (!cuts.length) return null;
      const { playhead, selectedId } = get();
      const selIndex = cuts.findIndex((c) => c.id === selectedId);
      let target: GlobalCut | undefined;
      if (selIndex >= 0 && Math.abs(cuts[selIndex].gStart - playhead) < 0.05) {
        target = cuts[selIndex + dir];
      } else if (dir > 0) {
        target = cuts.find((c) => c.gStart > playhead + 0.05);
      } else {
        target = [...cuts].reverse().find((c) => c.gStart < playhead - 0.05);
      }
      if (!target) return null;
      set({ selectedId: target.id, playhead: target.gStart, seekNonce: get().seekNonce + 1, stopAt: null, playing: false, selection: null });
      return target;
    },

    playAroundCut(id) {
      const cuts = get().sortedCuts();
      const cut = cuts.find((c) => c.id === (id ?? get().selectedId)) ?? cuts.find((c) => c.gStart >= get().playhead - 0.05);
      if (!cut) return;
      set({ selectedId: cut.id });
      get().playRange(cut.gStart - REVIEW_CONTEXT, cut.gEnd + REVIEW_CONTEXT);
    },

    flushSave() {
      flush();
    },

    getEdits() {
      const { project } = get();
      if (!project) return null;
      // The server will receive these edits with the export request, so drop the pending autosave.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      pendingSave = null;
      return editsOf(project);
    },
  };
});
