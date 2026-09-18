import { compileSegments, formatTime, outputDuration, totalSourceDuration } from '@app/shared';
import { useEditor } from '../../store/editor';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, unit, onChange }: SliderProps) {
  return (
    <label className="param">
      <span className="param-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        className="param-num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
      <span className="param-unit">{unit}</span>
    </label>
  );
}

export function ParamsPanel() {
  const project = useEditor((s) => s.project);
  const analyses = useEditor((s) => s.analyses);
  const setParams = useEditor((s) => s.setParams);
  if (!project) return null;

  // Noise floor (10th percentile of the envelope) + 5 dB: a sensible threshold for quiet recordings.
  const autoThreshold = () => {
    const all: number[] = [];
    for (const a of Object.values(analyses)) for (const v of a.rmsDb) all.push(v);
    if (!all.length) return;
    all.sort((x, y) => x - y);
    const floor = all[Math.floor(all.length * 0.1)];
    setParams({ thresholdDb: Math.max(-80, Math.min(-10, floor + 5)) });
  };
  const { params } = project;
  const segments = compileSegments(project);
  const source = totalSourceDuration(project.clips);
  const out = outputDuration(segments);
  const active = project.cuts.filter((c) => c.action === 'cut').length;
  const kept = project.cuts.filter((c) => c.action === 'keep').length;

  return (
    <div className="params">
      <div className="params-sliders">
        <div className="param-row">
          <Slider label="Silence threshold" value={params.thresholdDb} min={-80} max={-10} step={1} unit="dB" onChange={(v) => setParams({ thresholdDb: v })} />
          <button className="btn small" style={{ marginTop: 0 }} onClick={autoThreshold} title="noise floor + 5 dB">
            auto
          </button>
        </div>
        <Slider label="Min duration" value={params.minDuration} min={0.1} max={5} step={0.05} unit="s" onChange={(v) => setParams({ minDuration: v })} />
        <Slider label="Padding" value={params.padding} min={0} max={1} step={0.01} unit="s" onChange={(v) => setParams({ padding: v })} />
      </div>
      <div className="params-stats">
        <div>
          <span className="stat-label">cuts</span> <b>{active}</b>
          {kept > 0 && <span className="muted"> (+{kept} kept)</span>}
        </div>
        <div>
          <span className="stat-label">source</span> <b>{formatTime(source)}</b>
        </div>
        <div>
          <span className="stat-label">output</span> <b>{formatTime(out)}</b>
          <span className="muted"> ({source > 0 ? Math.round((1 - out / source) * 100) : 0}% shorter)</span>
        </div>
      </div>
    </div>
  );
}
