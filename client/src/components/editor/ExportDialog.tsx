import { useEffect, useState } from 'react';
import { compileSegments, exportTarget, formatTime, outputDuration, totalSourceDuration, type AppConfigPublic } from '@app/shared';
import { api } from '../../api';
import { useEditor } from '../../store/editor';

interface Props {
  onClose: () => void;
}

export function ExportDialog({ onClose }: Props) {
  const project = useEditor((s) => s.project);
  const getEdits = useEditor((s) => s.getEdits);
  const [cfg, setCfg] = useState<AppConfigPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!project) return null;
  const segments = compileSegments(project);
  const out = outputDuration(segments);
  const source = totalSourceDuration(project.clips);
  const target = exportTarget(project.clips, cfg?.export);
  const speedCount = segments.filter((s) => s.speed !== 1).length;
  const willMove = project.location === 'inbox';

  const start = async () => {
    const edits = getEdits();
    if (!edits) return;
    setBusy(true);
    setError(null);
    try {
      await api.startExport(project.id, edits);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Export “{project.name}”</h3>
        <table className="export-facts">
          <tbody>
            <tr>
              <td>output length</td>
              <td>
                <b>{formatTime(out)}</b> <span className="muted">(source {formatTime(source)}, {source > 0 ? Math.round((1 - out / source) * 100) : 0}% shorter)</span>
              </td>
            </tr>
            <tr>
              <td>segments</td>
              <td>
                {segments.length}
                {speedCount > 0 && <span className="muted"> · {speedCount} sped up</span>}
              </td>
            </tr>
            <tr>
              <td>video</td>
              <td>
                {target.width}×{target.height} @ {target.fps} fps · {cfg?.export.encoder ?? 'libx264'} crf {cfg?.export.crf ?? 18} ({cfg?.export.preset ?? 'medium'})
              </td>
            </tr>
            <tr>
              <td>audio</td>
              <td>AAC 48 kHz stereo</td>
            </tr>
            <tr>
              <td>saves to</td>
              <td>
                <code>{cfg?.output ?? 'output/'}</code>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted export-note">
          {willMove
            ? 'The original file(s) are re-encoded from the source and then moved to the done folder. The project stays editable and can be exported again.'
            : 'The originals are already in the done folder; this will write a new file to output.'}
        </p>
        {error && <p className="export-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn primary" onClick={start} disabled={busy || segments.length === 0}>
            {busy ? 'starting…' : 'export'}
          </button>
        </div>
      </div>
    </div>
  );
}
