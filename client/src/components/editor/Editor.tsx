import { useState } from 'react';
import { compileSegments, formatTime, GAIN_STEPS, gainLabel, outputDuration, sourceToOutput } from '@app/shared';
import { api } from '../../api';
import { useHotkeys } from '../../hotkeys';
import { useEditor } from '../../store/editor';
import { ClipList } from './ClipList';
import { ExportDialog } from './ExportDialog';
import { ParamsPanel } from './ParamsPanel';
import { Player } from './Player';
import { ReviewPanel } from './ReviewPanel';
import { Timeline } from './Timeline';

export function Editor() {
  const project = useEditor((s) => s.project);
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.error);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selection = useEditor((s) => s.selection);
  const selectedId = useEditor((s) => s.selectedId);
  const setPlaying = useEditor((s) => s.setPlaying);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const cutSelection = useEditor((s) => s.cutSelection);
  const speedSelection = useEditor((s) => s.speedSelection);
  const resetSpeedSelection = useEditor((s) => s.resetSpeedSelection);
  const gainSelection = useEditor((s) => s.gainSelection);
  const resetGainSelection = useEditor((s) => s.resetGainSelection);
  const toggleCut = useEditor((s) => s.toggleCut);
  const removeRange = useEditor((s) => s.removeRange);
  const jumpCut = useEditor((s) => s.jumpCut);
  const playAroundCut = useEditor((s) => s.playAroundCut);
  const [showExport, setShowExport] = useState(false);
  const [xmlMsg, setXmlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [audioMsg, setAudioMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const getEdits = useEditor((s) => s.getEdits);

  useHotkeys();

  if (loading) return <div className="empty">Loading…</div>;
  if (error) return <div className="empty">Error: {error}</div>;
  if (!project) return null;

  const segments = compileSegments(project);
  const outT = sourceToOutput(segments, project.clips, playhead);
  const ready = project.clips.every((c) => c.status === 'ready');
  const selectedCut = selectedId ? project.cuts.find((c) => c.id === selectedId) : undefined;
  const selectedSpeed = selectedId ? project.speeds.find((s) => s.id === selectedId) : undefined;
  const selectedGain = selectedId ? (project.gains ?? []).find((g) => g.id === selectedId) : undefined;
  const speedTarget = !!selection || !!selectedSpeed || !!selectedCut;
  const gainTarget = !!selection || !!selectedGain || !!selectedCut || !!selectedSpeed;
  const exp = project.export;
  const exporting = exp?.status === 'running';

  return (
    <div className="editor">
      <header className="editor-header">
        <h2>{project.name}</h2>
        <span className="status-line">
          {project.location === 'missing' && 'source missing · '}
          {project.clips
            .map((c) => (c.status === 'ready' ? null : `${c.file}: ${c.status} ${Math.round(c.progress * 100)}%`))
            .filter(Boolean)
            .join(' · ')}
          {ready && `${project.clips.length} clip${project.clips.length > 1 ? 's' : ''} ready`}
        </span>
        {exporting ? (
          <span className="export-status">
            <span className="progress export-progress">
              <span className="progress-bar" style={{ width: `${Math.round(exp.progress * 100)}%`, display: 'block' }} />
            </span>
            <span className="muted">{exp.message ?? 'exporting'}</span>
            <button className="btn small" style={{ marginTop: 0 }} onClick={() => void api.cancelExport(project.id)}>
              cancel
            </button>
          </span>
        ) : (
          <span className="export-status">
            {exp?.status === 'done' && exp.outputPath && (
              <span className="muted" title={exp.outputPath}>
                exported ✓ <code>{exp.outputPath.split(/[\\/]/).pop()}</code>
              </span>
            )}
            {exp?.status === 'error' && (
              <span className="export-error" title={exp.message}>
                export failed: {exp.message?.slice(0, 80)}
              </span>
            )}
            {exp?.status === 'cancelled' && <span className="muted">export cancelled</span>}
            {xmlMsg && <span className={xmlMsg.ok ? 'muted' : 'export-error'}>{xmlMsg.text}</span>}
            {audioMsg && <span className={audioMsg.ok ? 'muted' : 'export-error'}>{audioMsg.text}</span>}
            <button
              className="btn"
              disabled={!ready || project.location === 'missing' || audioBusy}
              title={
                selection
                  ? 'Render just the selected range of the soundtrack into the output folder. Press Esc to export the whole timeline instead.'
                  : 'Render only the edited soundtrack (cuts, order, speed, volume) into the output folder. Nothing is moved.'
              }
              onClick={() => {
                // The selection is in source-timeline seconds; the renderer works in output seconds.
                const range = selection
                  ? { start: sourceToOutput(segments, project.clips, selection.start), end: sourceToOutput(segments, project.clips, selection.end) }
                  : undefined;
                const edits = getEdits();
                if (!edits) return;
                setAudioBusy(true);
                setAudioMsg({ ok: true, text: 'audio: rendering…' });
                api
                  .exportAudio(project.id, edits, range)
                  .then((r) => setAudioMsg({ ok: true, text: 'audio ✓ ' + (r.path.split(/[\\/]/).pop() ?? '') + ' · ' + formatTime(r.duration) }))
                  .catch((e: Error) => setAudioMsg({ ok: false, text: 'audio failed: ' + e.message }))
                  .finally(() => setAudioBusy(false));
              }}
            >
              {audioBusy ? 'audio…' : selection ? 'audio ⧉' : 'audio'}
            </button>
            <button
              className="btn"
              disabled={!ready || project.location === 'missing'}
              title="Write <name>.fcpxml (DaVinci Resolve / Final Cut) and <name>.edl into the output folder, referencing the original files"
              onClick={() => {
                const edits = getEdits();
                if (!edits) return;
                api
                  .exportXml(project.id, edits)
                  .then((r) => setXmlMsg({ ok: true, text: `xml ✓ ${r.fcpxml.split(/[\\/]/).pop()} + .edl` }))
                  .catch((e: Error) => setXmlMsg({ ok: false, text: `xml failed: ${e.message}` }));
              }}
            >
              xml
            </button>
            <button className="btn primary" onClick={() => setShowExport(true)} disabled={!ready || project.location === 'missing'} title="Render the edited video from the originals">
              export
            </button>
          </span>
        )}
        <button className="btn" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          undo
        </button>
        <button className="btn" onClick={redo} disabled={!canRedo} title="Ctrl+Y">
          redo
        </button>
      </header>
      <div className="editor-body">
        <div className="editor-main">
          <Player />
          <div className="transport">
            <button className="btn" onClick={() => jumpCut(-1)} title="previous cut (,)">
              ⏮
            </button>
            <button className="btn" onClick={() => setPlaying(!playing)} title="Space">
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="btn" onClick={() => jumpCut(1)} title="next cut (.)">
              ⏭
            </button>
            <button className="btn" onClick={() => playAroundCut()} title="play around cut (Enter)">
              ↻ cut
            </button>
            <span className="time">
              <b>{formatTime(playhead, true)}</b> · out <b>{formatTime(outT, true)}</b> / {formatTime(outputDuration(segments), true)}
            </span>
            <span className="spacer" />
            <span className="tools">
              {selection && (
                <span className="muted">
                  sel {formatTime(selection.start, true)}–{formatTime(selection.end, true)}
                </span>
              )}
              <button className="btn" disabled={!selection} onClick={cutSelection} title="C">
                cut
              </button>
              <select
                className={`btn speed-select ${selectedSpeed ? 'primary' : ''}`}
                disabled={!speedTarget}
                value={selectedSpeed?.factor ?? ''}
                onChange={(e) => {
                  const f = Number(e.target.value);
                  if (f === 1) resetSpeedSelection();
                  else if (f === 2 || f === 4 || f === 8 || f === 16) speedSelection(f);
                }}
                title="speed: keys 2 / 4 / 8 / 6 (16×), 1 = off"
              >
                <option value="" disabled hidden>
                  speed
                </option>
                <option value="1">off</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
                <option value="8">8×</option>
                <option value="16">16× muted</option>
              </select>
              <select
                className={'btn gain-select ' + (selectedGain ? 'primary' : '')}
                disabled={!gainTarget}
                value={selectedGain ? String(selectedGain.db) : ''}
                onChange={(e) => {
                  if (e.target.value === 'off') resetGainSelection();
                  else if (e.target.value !== '') gainSelection(Number(e.target.value));
                }}
                title="volume of the selection or selected block: M = mute, 0 = off"
              >
                <option value="" disabled hidden>
                  volume
                </option>
                <option value="off">off</option>
                {selectedGain && !GAIN_STEPS.includes(selectedGain.db) && <option value={String(selectedGain.db)}>{gainLabel(selectedGain.db)}</option>}
                {GAIN_STEPS.filter((g) => g !== 0).map((g) => (
                  <option key={g} value={String(g)}>
                    {gainLabel(g)}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!selectedCut} onClick={() => selectedId && toggleCut(selectedId)} title="K">
                {selectedCut?.action === 'keep' ? 'cut it' : 'keep'}
              </button>
              <button className="btn" disabled={!selectedId} onClick={() => selectedId && removeRange(selectedId)} title="Delete">
                delete
              </button>
            </span>
          </div>
          <ClipList />
          <Timeline />
          <ParamsPanel />
        </div>
        <ReviewPanel />
      </div>
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
    </div>
  );
}
