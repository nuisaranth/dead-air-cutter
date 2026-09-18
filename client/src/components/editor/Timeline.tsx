import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { clipOffsets, gainLabel, totalSourceDuration } from '@app/shared';
import { useEditor } from '../../store/editor';

export const COLORS = {
  cut: 'rgba(239,68,68,0.45)',
  keep: 'rgba(148,163,184,0.28)',
  speed: 'rgba(245,158,11,0.35)',
  gain: 'rgba(52,211,153,0.28)',
  trim: 'rgba(239,68,68,0.6)',
  selection: 'rgba(56,189,248,0.25)',
};

const SELECTION_ID = 'sel';

interface Wanted {
  start: number;
  end: number;
  color: string;
  resize: boolean;
  drag: boolean;
}

const isOurs = (id: string) => id.includes(':') || id === SELECTION_ID;

export function Timeline() {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [ready, setReady] = useState(0);

  const project = useEditor((s) => s.project);
  const analyses = useEditor((s) => s.analyses);
  const selectedId = useEditor((s) => s.selectedId);
  const selection = useEditor((s) => s.selection);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const select = useEditor((s) => s.select);
  const setSelection = useEditor((s) => s.setSelection);
  const moveRange = useEditor((s) => s.moveRange);
  const setTrim = useEditor((s) => s.setTrim);

  const clips = project?.clips ?? [];
  const total = totalSourceDuration(clips);
  const offsets = useMemo(() => clipOffsets(clips), [clips]);
  // Edits (cuts, keeps, speeds, trims) produce new clip objects but the same waveform:
  // key the peaks on identity + duration so wavesurfer is not rebuilt (which would reset the zoom).
  const clipsKey = clips.map((c) => `${c.id}:${c.duration}`).join('|');
  const zoomRef = useRef<{ pxPerSec: number; scrollLeft: number } | null>(null);

  // One continuous peaks array across all clips (zeros where analysis is not ready yet).
  const peaks = useMemo(() => {
    const parts: number[][] = [];
    let length = 0;
    for (const clip of clips) {
      const a = analyses[clip.id];
      const rate = a?.peaksPerSecond ?? 20;
      const n = Math.max(1, Math.round(clip.duration * rate));
      const arr = new Array<number>(n).fill(0);
      if (a) for (let i = 0; i < n && i < a.peaks.length; i++) arr[i] = a.peaks[i];
      parts.push(arr);
      length += n;
    }
    const out = new Float32Array(length);
    let i = 0;
    for (const p of parts) for (const v of p) out[i++] = v;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsKey, analyses]);

  // Create / recreate wavesurfer when the peaks change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || total <= 0) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      height: 120,
      waveColor: '#67c7ef',
      progressColor: '#67c7ef',
      cursorWidth: 0,
      peaks: [peaks],
      duration: total,
      minPxPerSec: Math.max(1, (container.clientWidth - 2) / total),
      interact: true,
      normalize: true,
      autoScroll: false,
      autoCenter: false,
      dragToSeek: false,
      plugins: [regions, TimelinePlugin.create({ height: 18, style: { color: '#8a92a6', fontSize: '10px' } })],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    const wrapper = ws.getWrapper();
    const playhead = document.createElement('div');
    Object.assign(playhead.style, {
      position: 'absolute',
      top: '0',
      bottom: '0',
      width: '2px',
      marginLeft: '-1px',
      background: '#ffffff',
      zIndex: '8',
      pointerEvents: 'none',
      left: '0%',
    });
    wrapper.appendChild(playhead);
    playheadRef.current = playhead;

    ws.on('interaction', (t) => setPlayhead(t, true));
    regions.on('region-clicked', (region) => {
      if (region.id !== SELECTION_ID) select(region.id);
    });
    regions.on('region-updated', (region) => {
      if (!isOurs(region.id)) return;
      if (region.id === SELECTION_ID) {
        setSelection({ start: region.start, end: region.end });
        return;
      }
      const st = useEditor.getState();
      const range = st.project?.cuts.find((c) => c.id === region.id) ?? st.project?.speeds.find((s) => s.id === region.id);
      if (!range || !st.project) return;
      const off = clipOffsets(st.project.clips)[st.project.clips.findIndex((c) => c.id === range.clipId)] ?? 0;
      moveRange(region.id, region.start - off, region.end - off);
    });
    regions.on('region-created', (region) => {
      if (isOurs(region.id)) return;
      // Drag on the waveform: becomes the selection.
      const { start, end } = region;
      region.remove();
      select(null);
      setSelection({ start, end });
    });
    const disableDrag = regions.enableDragSelection({ color: COLORS.selection, drag: false, resize: false }, 4);

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const fit = (container.clientWidth - 2) / total;
      const current = ws.options.minPxPerSec || fit;
      const next = Math.max(fit, Math.min(400, current * (e.deltaY < 0 ? 1.25 : 0.8)));
      ws.zoom(next);
      zoomRef.current = { pxPerSec: next, scrollLeft: wrapper.parentElement?.scrollLeft ?? 0 };
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    const onScroll = () => {
      if (zoomRef.current) zoomRef.current.scrollLeft = wrapper.parentElement?.scrollLeft ?? 0;
    };
    wrapper.parentElement?.addEventListener('scroll', onScroll);
    // Restore the zoom level and scroll position from before a rebuild.
    ws.once('ready', () => {
      const z = zoomRef.current;
      if (!z) return;
      const fit = (container.clientWidth - 2) / total;
      if (z.pxPerSec > fit * 1.01) {
        ws.zoom(z.pxPerSec);
        requestAnimationFrame(() => {
          if (wrapper.parentElement) wrapper.parentElement.scrollLeft = z.scrollLeft;
        });
      }
    });

    setReady((n) => n + 1);
    return () => {
      container.removeEventListener('wheel', onWheel);
      wrapper.parentElement?.removeEventListener('scroll', onScroll);
      disableDrag();
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      playheadRef.current = null;
      handlesRef.current.clear();
    };
  }, [peaks, total, setPlayhead, select, setSelection, moveRange]);

  // Keep the region set in sync with cuts / speeds / trims / selection.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !project) return;
    const wanted = new Map<string, Wanted>();
    const offsetOf = (clipId: string) => offsets[project.clips.findIndex((c) => c.id === clipId)] ?? 0;
    for (const cut of project.cuts) {
      const off = offsetOf(cut.clipId);
      wanted.set(cut.id, { start: off + cut.start, end: off + cut.end, color: cut.action === 'cut' ? COLORS.cut : COLORS.keep, resize: true, drag: false });
    }
    for (const sp of project.speeds) {
      const off = offsetOf(sp.clipId);
      wanted.set(sp.id, { start: off + sp.start, end: off + sp.end, color: COLORS.speed, resize: true, drag: false });
    }
    for (const g of project.gains ?? []) {
      const off = offsetOf(g.clipId);
      wanted.set(g.id, { start: off + g.start, end: off + g.end, color: COLORS.gain, resize: true, drag: false });
    }
    project.clips.forEach((clip, i) => {
      if (clip.trimStart > 0) wanted.set(`t:${clip.id}:head`, { start: offsets[i], end: offsets[i] + clip.trimStart, color: COLORS.trim, resize: false, drag: false });
      if (clip.trimEnd > 0)
        wanted.set(`t:${clip.id}:tail`, { start: offsets[i] + clip.duration - clip.trimEnd, end: offsets[i] + clip.duration, color: COLORS.trim, resize: false, drag: false });
    });
    if (selection) wanted.set(SELECTION_ID, { start: selection.start, end: selection.end, color: COLORS.selection, resize: true, drag: true });

    const existing = new Map<string, Region>(regions.getRegions().map((r) => [r.id, r]));
    for (const [id, r] of existing) if (!wanted.has(id)) r.remove();
    for (const [id, w] of wanted) {
      let r = existing.get(id);
      if (!r) {
        r = regions.addRegion({ id, start: w.start, end: w.end, color: w.color, drag: w.drag, resize: w.resize });
      } else if (Math.abs(r.start - w.start) > 1e-4 || Math.abs(r.end - w.end) > 1e-4 || r.color !== w.color) {
        r.setOptions({ start: w.start, end: w.end, color: w.color });
      }
      const sp = project.speeds.find((s) => s.id === id);
      const gn = (project.gains ?? []).find((g) => g.id === id);
      decorate(r, id === selectedId, sp ? sp.factor + '×' : gn ? gainLabel(gn.db) : '', id === SELECTION_ID);
    }
  }, [project, offsets, ready, selectedId, selection]);

  // Draggable trim handles at each clip's head and tail.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !project || total <= 0) return;
    const wrapper = ws.getWrapper();
    const handles = handlesRef.current;
    const keep = new Set<string>();
    project.clips.forEach((clip, i) => {
      for (const edge of ['head', 'tail'] as const) {
        const key = `${clip.id}:${edge}`;
        keep.add(key);
        let el = handles.get(key);
        if (!el) {
          el = document.createElement('div');
          el.title = edge === 'head' ? 'drag to trim the start' : 'drag to trim the end';
          Object.assign(el.style, {
            position: 'absolute',
            top: '0',
            height: '100%',
            width: '10px',
            cursor: 'ew-resize',
            zIndex: '7',
            background: 'linear-gradient(rgba(255,255,255,0.7), rgba(255,255,255,0.7)) no-repeat',
            backgroundSize: '2px 100%',
            backgroundPosition: edge === 'head' ? 'left' : 'right',
            borderTop: '6px solid #fff',
            boxSizing: 'border-box',
            marginLeft: edge === 'head' ? '0' : '-10px',
          });
          el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            el!.setPointerCapture(e.pointerId);
            const rect = wrapper.getBoundingClientRect();
            const move = (ev: PointerEvent) => {
              const t = Math.max(0, Math.min(total, ((ev.clientX - rect.left) / rect.width) * total));
              const st = useEditor.getState();
              const c = st.project?.clips.find((x) => x.id === clip.id);
              const off = st.project ? clipOffsets(st.project.clips)[st.project.clips.findIndex((x) => x.id === clip.id)] : 0;
              if (!c) return;
              if (edge === 'head') setTrim(clip.id, { trimStart: t - off });
              else setTrim(clip.id, { trimEnd: off + c.duration - t });
            };
            const up = () => {
              el!.removeEventListener('pointermove', move);
              el!.removeEventListener('pointerup', up);
            };
            el!.addEventListener('pointermove', move);
            el!.addEventListener('pointerup', up);
          });
          el.addEventListener('click', (e) => e.stopPropagation());
          wrapper.appendChild(el);
          handles.set(key, el);
        }
        const t = edge === 'head' ? offsets[i] + clip.trimStart : offsets[i] + clip.duration - clip.trimEnd;
        el.style.left = `${(t / total) * 100}%`;
      }
    });
    for (const [key, el] of handles) {
      if (!keep.has(key)) {
        el.remove();
        handles.delete(key);
      }
    }
  }, [project, offsets, total, ready, setTrim]);

  // Clip boundary markers (multi-clip): a line at each clip start plus the file name.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !project || total <= 0 || project.clips.length < 2) return;
    const wrapper = ws.getWrapper();
    const els: HTMLDivElement[] = [];
    project.clips.forEach((clip, i) => {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        top: '0',
        bottom: '0',
        left: `${(offsets[i] / total) * 100}%`,
        borderLeft: i > 0 ? '2px dashed rgba(255,255,255,0.55)' : 'none',
        zIndex: '7',
        pointerEvents: 'none',
      });
      const label = document.createElement('div');
      label.textContent = `${i + 1}. ${clip.file}`;
      Object.assign(label.style, {
        position: 'absolute',
        top: '2px',
        left: '4px',
        padding: '1px 5px',
        borderRadius: '3px',
        background: 'rgba(15,17,21,0.75)',
        color: '#e6e8ee',
        fontSize: '10px',
        whiteSpace: 'nowrap',
        maxWidth: '220px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      el.appendChild(label);
      wrapper.appendChild(el);
      els.push(el);
    });
    return () => {
      for (const el of els) el.remove();
    };
  }, [project, offsets, total, ready]);

  // Playhead overlay follows the store without re-rendering React.
  useEffect(() => {
    const update = (t: number, playing: boolean) => {
      const el = playheadRef.current;
      const ws = wsRef.current;
      if (!el || !ws || total <= 0) return;
      el.style.left = `${(t / total) * 100}%`;
      if (playing) {
        const wrapper = ws.getWrapper();
        const scroller = wrapper.parentElement;
        if (!scroller) return;
        const px = (t / total) * wrapper.clientWidth;
        const left = scroller.scrollLeft;
        const width = scroller.clientWidth;
        if (px < left || px > left + width - 10) scroller.scrollLeft = Math.max(0, px - width * 0.15);
      }
    };
    update(useEditor.getState().playhead, false);
    return useEditor.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead || s.playing !== prev.playing) update(s.playhead, s.playing);
    });
  }, [total, ready]);

  if (!project) return null;
  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={containerRef} />
      <div className="timeline-hint">
        <span>
          <i className="legend" style={{ background: COLORS.cut }} />
          cut
        </span>
        <span>
          <i className="legend" style={{ background: COLORS.keep }} />
          kept silence
        </span>
        <span>
          <i className="legend" style={{ background: COLORS.speed }} />
          sped up
        </span>
        <span>
          <i className="legend" style={{ background: COLORS.gain }} />
          volume
        </span>
        <span>
          <i className="legend" style={{ background: COLORS.selection }} />
          selection
        </span>
        <span className="muted">drag = select · drag edges = resize · white tabs = trim · ctrl+wheel = zoom</span>
      </div>
    </div>
  );
}

function decorate(region: Region, selected: boolean, label: string, isSelection: boolean): void {
  const el = region.element as HTMLElement | undefined;
  if (!el) return;
  el.style.outline = selected ? '2px solid #fff' : isSelection ? '1px dashed rgba(56,189,248,0.9)' : 'none';
  el.style.outlineOffset = '-2px';
  el.style.zIndex = isSelection ? '6' : selected ? '5' : '3';
  if (el.dataset.label !== label) {
    el.dataset.label = label;
    el.textContent = '';
    if (label) {
      const span = document.createElement('span');
      span.textContent = label;
      Object.assign(span.style, { position: 'absolute', left: '4px', top: '2px', fontSize: '11px', fontWeight: '600', color: '#fde68a', pointerEvents: 'none' });
      el.appendChild(span);
    }
  }
}
