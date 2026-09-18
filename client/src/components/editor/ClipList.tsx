import { useState } from 'react';
import { clipGainLabel, clipOffsets, formatTime, GAIN_STEPS, gainLabel, globalToClip, MUTE_DB } from '@app/shared';
import { useEditor } from '../../store/editor';

/** Order strip for multi-clip projects: click = jump to the clip, drag = reorder. */
export function ClipList() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const reorderClips = useEditor((s) => s.reorderClips);
  const setClipGain = useEditor((s) => s.setClipGain);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (!project || !project.clips.length) return null;
  const clips = project.clips;
  const offsets = clipOffsets(clips);
  const currentId = globalToClip(clips, playhead)?.clipId;

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = clips.map((c) => c.id).filter((id) => id !== dragId);
    const at = ids.indexOf(targetId);
    const from = clips.findIndex((c) => c.id === dragId);
    const to = clips.findIndex((c) => c.id === targetId);
    // Dropping on a later clip puts the dragged one after it, on an earlier one before it.
    ids.splice(from < to ? at + 1 : at, 0, dragId);
    reorderClips(ids);
  };

  const move = (id: string, dir: -1 | 1) => {
    const ids = clips.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderClips(ids);
  };

  return (
    <div className="clip-list" title={clips.length > 1 ? 'Clips play in this order. Drag to reorder.' : undefined}>
      {clips.map((c, i) => (
        <div
          key={c.id}
          className={[
            'clip-chip',
            c.id === currentId ? 'current' : '',
            c.id === overId && dragId !== c.id ? 'over' : '',
            c.id === dragId ? 'dragging' : '',
            (c.gainDb ?? 0) <= MUTE_DB ? 'muted' : (c.gainDb ?? 0) !== 0 ? 'gained' : '',
            'status-' + c.status,
          ]
            .filter(Boolean)
            .join(' ')}
          draggable={clips.length > 1}
          onDragStart={(e) => {
            setDragId(c.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', c.id);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (overId !== c.id) setOverId(c.id);
          }}
          onDragLeave={() => overId === c.id && setOverId(null)}
          onDrop={(e) => {
            e.preventDefault();
            drop(c.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          onClick={() => setPlayhead(offsets[i] + c.trimStart, true)}
        >
          <span className="clip-index">{i + 1}</span>
          <span className="clip-name">{c.file}</span>
          <span className="muted clip-meta">
            {formatTime(c.duration)}
            {c.width > 0 && ` · ${c.width}×${c.height}`}
            {c.fps > 0 && ` @ ${Math.round(c.fps * 100) / 100}`}
            {c.status !== 'ready' && ` · ${c.status} ${Math.round(c.progress * 100)}%`}
          </span>
          <select
            className="btn small clip-gain"
            value={String(c.gainDb ?? 0)}
            title={
              (c.gainDb ?? 0) === 0
                ? 'Volume of this WHOLE clip; volume ranges on the timeline add on top'
                : 'This whole clip is at ' + gainLabel(c.gainDb ?? 0) + '. Set it back to 0 dB to leave the clip alone.'
            }
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setClipGain(c.id, Number(e.target.value))}
          >
            {!GAIN_STEPS.includes(c.gainDb ?? 0) && <option value={String(c.gainDb ?? 0)}>{clipGainLabel(c.gainDb ?? 0)}</option>}
            {GAIN_STEPS.map((g) => (
              <option key={g} value={String(g)}>
                {clipGainLabel(g)}
              </option>
            ))}
          </select>
          {clips.length > 1 && (
          <span className="clip-move">
            <button
              className="btn small"
              disabled={i === 0}
              onClick={(e) => {
                e.stopPropagation();
                move(c.id, -1);
              }}
              title="move earlier"
            >
              ◀
            </button>
            <button
              className="btn small"
              disabled={i === clips.length - 1}
              onClick={(e) => {
                e.stopPropagation();
                move(c.id, 1);
              }}
              title="move later"
            >
              ▶
            </button>
          </span>
          )}
        </div>
      ))}
    </div>
  );
}
