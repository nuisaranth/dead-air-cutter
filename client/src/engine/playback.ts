import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { clipToGlobal, cutRangesForClip, dbToLinear, globalToClip, SPEED_MUTE_FROM, type ProjectFile } from '@app/shared';
import { useEditor } from '../store/editor';

/**
 * Drives a <video> element playing the proxy of one clip so that preview
 * playback skips cut ranges, applies speed ranges and stops at `stopAt`.
 * Runs a requestAnimationFrame loop while playing and mirrors time into the store.
 */
export function usePlaybackEngine(videoRef: RefObject<HTMLVideoElement | null>, project: ProjectFile | null, clipId: string | null) {
  const playing = useEditor((s) => s.playing);
  const seekNonce = useEditor((s) => s.seekNonce);
  const pendingSeek = useRef<number | null>(null);

  const clip = project?.clips.find((c) => c.id === clipId) ?? null;
  const removed = useMemo(() => (project && clip ? cutRangesForClip(clip, project.cuts) : []), [project, clip]);
  const speeds = useMemo(() => (project && clip ? project.speeds.filter((s) => s.clipId === clip.id) : []), [project, clip]);
  const removedRef = useRef(removed);
  const gains = useMemo(() => (project && clip ? (project.gains ?? []).filter((g) => g.clipId === clip.id) : []), [project, clip]);
  const speedsRef = useRef(speeds);
  const gainsRef = useRef(gains);
  removedRef.current = removed;
  speedsRef.current = speeds;
  gainsRef.current = gains;

  const seekTo = (v: HTMLVideoElement, t: number) => {
    pendingSeek.current = t;
    v.currentTime = t;
  };

  // External seeks (timeline clicks, hotkeys, review jumps).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !project || !clip) return;
    const ct = globalToClip(project.clips, useEditor.getState().playhead);
    if (ct && ct.clipId === clip.id && Math.abs(v.currentTime - ct.time) > 0.02) seekTo(v, ct.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce, clip?.id, videoRef]);

  // Play / pause (re-run when the clip under the playhead changes so playback continues on the new src).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.play().catch(() => useEditor.getState().setPlaying(false));
    } else {
      v.pause();
      v.playbackRate = 1;
      v.muted = false;
    }
  }, [playing, clip?.id, videoRef]);

  // The loop.
  useEffect(() => {
    const v = videoRef.current;
    if (!playing || !v || !project || !clip) return;
    const clips = project.clips;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (v.paused && !v.seeking) return;
      const st = useEditor.getState();
      if (v.seeking || (pendingSeek.current != null && Math.abs(v.currentTime - pendingSeek.current) > 0.25)) return;
      pendingSeek.current = null;
      const local = v.currentTime;

      // Inside removed material: jump to its end (or stop at the end of the clip).
      const r = removedRef.current.find((x) => local >= x.start - 0.004 && local < x.end);
      if (r) {
        if (r.end >= clip.duration - 0.02) {
          // Removed material reaches the end of this clip: continue on the next clip or stop.
          const i = clips.findIndex((c) => c.id === clip.id);
          if (i >= 0 && i < clips.length - 1) {
            st.setPlayhead(clipToGlobal(clips, clips[i + 1].id, 0), true, true);
            return;
          }
          v.pause();
          st.setPlaying(false);
          st.setPlayhead(clipToGlobal(clips, clip.id, clip.duration));
          return;
        }
        seekTo(v, r.end);
        st.setPlayhead(clipToGlobal(clips, clip.id, r.end));
        return;
      }

      const sp = speedsRef.current.find((x) => local >= x.start && local < x.end);
      // Browsers cap playbackRate at 16; mute like the export does at high speeds.
      const rate = Math.min(16, sp ? sp.factor : 1);
      if (v.playbackRate !== rate) v.playbackRate = rate;
      // Preview can attenuate and mute but not boost: <video>.volume is capped at 1. Export boosts freely.
      const gr = gainsRef.current.find((x) => local >= x.start && local < x.end);
      const vol = Math.min(1, dbToLinear((clip.gainDb ?? 0) + (gr?.db ?? 0)));
      const muted = (!!sp && sp.factor >= SPEED_MUTE_FROM) || vol === 0;
      if (v.muted !== muted) v.muted = muted;
      if (Math.abs(v.volume - vol) > 0.001) v.volume = vol;

      const global = clipToGlobal(clips, clip.id, local);
      if (st.stopAt != null && global >= st.stopAt) {
        v.pause();
        st.setPlaying(false);
        st.setPlayhead(st.stopAt);
        return;
      }
      st.setPlayhead(global);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project, clip, videoRef]);
}
