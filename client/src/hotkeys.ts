import { useEffect } from 'react';
import { globalToClip, MUTE_DB, totalSourceDuration } from '@app/shared';
import { useEditor } from './store/editor';

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const st = useEditor.getState();
      if (!st.project) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          st.setPlaying(!st.playing);
          return;
        case 'Enter':
          e.preventDefault();
          st.playAroundCut();
          return;
        case 'Comma':
          e.preventDefault();
          st.jumpCut(-1);
          return;
        case 'Period':
          e.preventDefault();
          st.jumpCut(1);
          return;
        case 'Escape':
          st.setSelection(null);
          st.select(null);
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (st.selectedId) st.removeRange(st.selectedId);
          else if (st.selection) st.setSelection(null);
          return;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = e.code === 'ArrowLeft' ? -1 : 1;
          const ct = globalToClip(st.project.clips, st.playhead);
          const fps = ct ? st.project.clips[ct.clipIndex].fps || 30 : 30;
          st.nudge(dir * (e.shiftKey ? 1 : 1 / fps));
          return;
        }
        case 'Home':
          e.preventDefault();
          st.setPlayhead(0, true);
          return;
        case 'End':
          e.preventDefault();
          st.setPlayhead(totalSourceDuration(st.project.clips), true);
          return;
      }

      switch (key) {
        case 'k': {
          e.preventDefault();
          const cut = st.currentCut() ?? st.sortedCuts().find((c) => st.playhead >= c.gStart - 0.05 && st.playhead <= c.gEnd + 0.05);
          if (!cut) return;
          st.toggleCut(cut.id);
          st.select(cut.id);
          if (st.reviewMode) {
            const next = st.jumpCut(1);
            if (next) st.playAroundCut(next.id);
          }
          return;
        }
        case 'c':
          e.preventDefault();
          st.cutSelection();
          return;
        case '2':
          st.speedSelection(2);
          return;
        case '4':
          st.speedSelection(4);
          return;
        case '8':
          st.speedSelection(8);
          return;
        case '6':
          st.speedSelection(16);
          return;
        case '1':
          st.resetSpeedSelection();
          return;
        case 'm':
          e.preventDefault();
          st.gainSelection(MUTE_DB);
          return;
        case '0':
          st.resetGainSelection();
          return;
        case 'i':
          st.trimAtPlayhead('head');
          return;
        case 'o':
          st.trimAtPlayhead('tail');
          return;
        case 'r':
          st.setReviewMode(!st.reviewMode);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
