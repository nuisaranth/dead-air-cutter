import { useEffect, useRef, useState } from 'react';
import { formatTime } from '@app/shared';
import { useEditor } from '../../store/editor';

export function ReviewPanel() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const reviewMode = useEditor((s) => s.reviewMode);
  const setReviewMode = useEditor((s) => s.setReviewMode);
  const select = useEditor((s) => s.select);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playAroundCut = useEditor((s) => s.playAroundCut);
  const toggleCut = useEditor((s) => s.toggleCut);
  const keepShortCuts = useEditor((s) => s.keepShortCuts);
  const cutAll = useEditor((s) => s.cutAll);
  const keepAll = useEditor((s) => s.keepAll);
  const listRef = useRef<HTMLUListElement>(null);
  const [shortThreshold, setShortThreshold] = useState(1);

  // Recompute on every project change (cuts move with params).
  const cuts = useEditor((s) => s.sortedCuts)();
  void project;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cut-row.selected');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const active = cuts.filter((c) => c.action === 'cut');
  const removedTotal = active.reduce((a, c) => a + (c.end - c.start), 0);

  return (
    <aside className="review">
      <div className="review-header">
        <span>
          <b>{active.length}</b> cuts · {formatTime(removedTotal)} removed
        </span>
        <button className={`btn small ${reviewMode ? 'primary' : ''}`} onClick={() => setReviewMode(!reviewMode)} title="R: after K, jump to the next cut and play around it">
          review mode
        </button>
      </div>
      <div className="review-bulk">
        <span className="muted">keep cuts shorter than</span>
        <input
          className="param-num"
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={shortThreshold}
          onChange={(e) => setShortThreshold(Math.max(0, Number(e.target.value) || 0))}
        />
        <span className="muted">s</span>
        <button className="btn small" style={{ marginTop: 0 }} onClick={() => keepShortCuts(shortThreshold)} title="Bulk-mark short natural pauses as kept instead of reviewing each one">
          apply
        </button>
      </div>
      <div className="review-bulk">
        <button className="btn small" style={{ marginTop: 0 }} onClick={cutAll} title="Mark every detected silence as cut">
          cut all
        </button>
        <button className="btn small" style={{ marginTop: 0 }} onClick={keepAll} title="Mark every detected silence as kept (nothing removed)">
          keep all
        </button>
      </div>
      <ul className="cut-list" ref={listRef}>
        {cuts.map((c, i) => (
          <li
            key={c.id}
            className={`cut-row ${c.action} ${c.id === selectedId ? 'selected' : ''}`}
            onClick={() => {
              select(c.id);
              setPlayhead(c.gStart, true);
            }}
            onDoubleClick={() => playAroundCut(c.id)}
          >
            <span className="cut-index">{i + 1}</span>
            <span className="cut-time">
              {formatTime(c.gStart, true)} <span className="muted">→</span> {formatTime(c.gEnd, true)}
            </span>
            <span className="cut-dur muted">{(c.end - c.start).toFixed(2)}s</span>
            <span className={`cut-src muted`}>{c.source}</span>
            <button
              className={`btn small cut-toggle ${c.action}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCut(c.id);
              }}
              title="K"
            >
              {c.action === 'cut' ? 'cut' : 'keep'}
            </button>
          </li>
        ))}
        {cuts.length === 0 && <li className="muted cut-empty">No silences detected. Lower the min duration or raise the threshold.</li>}
      </ul>
      <div className="review-help">
        <div>
          <span className="kbd">,</span> <span className="kbd">.</span> prev / next cut
        </div>
        <div>
          <span className="kbd">Enter</span> play around cut
        </div>
        <div>
          <span className="kbd">K</span> keep / cut
        </div>
        <div>
          <span className="kbd">C</span> cut selection · <span className="kbd">2</span> <span className="kbd">4</span> <span className="kbd">8</span> <span className="kbd">6</span> speed 2-16× · <span className="kbd">1</span> normal
        </div>
        <div>
          <span className="kbd">M</span> mute · <span className="kbd">0</span> volume off
        </div>
        <div>
          <span className="kbd">I</span> <span className="kbd">O</span> trim head / tail at playhead
        </div>
        <div>
          <span className="kbd">←</span> <span className="kbd">→</span> frame step (<span className="kbd">Shift</span> = 1 s)
        </div>
      </div>
    </aside>
  );
}
