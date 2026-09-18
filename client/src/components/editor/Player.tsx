import { useRef } from 'react';
import { clipToGlobal, globalToClip } from '@app/shared';
import { api } from '../../api';
import { usePlaybackEngine } from '../../engine/playback';
import { useEditor } from '../../store/editor';

export function Player() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const project = useEditor((s) => s.project);
  const setPlaying = useEditor((s) => s.setPlaying);
  const playhead = useEditor((s) => s.playhead);

  const clips = project?.clips ?? [];
  const current = globalToClip(clips, playhead);
  const clip = current ? clips[current.clipIndex] : undefined;
  const src = clip?.proxyReady ? api.proxyUrl(clip.id) : undefined;

  usePlaybackEngine(videoRef, project, clip?.id ?? null);

  return (
    <div className="player-area">
      {src ? (
        <video
          ref={videoRef}
          src={src}
          preload="auto"
          playsInline
          onEnded={() => {
            // Continue with the next clip, or stop at the very end.
            const st = useEditor.getState();
            const i = current?.clipIndex ?? -1;
            if (st.playing && i >= 0 && i < clips.length - 1) st.setPlayhead(clipToGlobal(clips, clips[i + 1].id, 0), true, true);
            else setPlaying(false);
          }}
          onClick={() => setPlaying(!useEditor.getState().playing)}
        />
      ) : (
        <div className="player-overlay">{clip ? `${clip.status}… ${Math.round(clip.progress * 100)}%` : 'no clip'}</div>
      )}
    </div>
  );
}
