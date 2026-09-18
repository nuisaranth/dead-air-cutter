import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime, type ProjectSummary } from '@app/shared';
import { api, useServerEvents } from '../api';

interface Props {
  activeId: string | null;
  onOpen: (id: string) => void;
}

const STATUS_LABEL: Record<ProjectSummary['status'], string> = {
  queued: 'queued',
  processing: 'processing',
  ready: 'ready',
  error: 'error',
  missing: 'missing',
};

export function QueuePanel({ activeId, onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [inbox, setInbox] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    api.config().then((c) => setInbox(c.inbox)).catch(() => {});
  }, [refresh]);

  useServerEvents(
    useCallback(() => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        refresh();
      }, 250);
    }, [refresh]),
  );

  return (
    <div className="queue">
      <div className="queue-inbox" title={inbox}>
        inbox: <code>{inbox}</code>
      </div>
      {projects.length === 0 && <div className="queue-empty">No projects yet.</div>}
      <ul className="queue-list">
        {projects.map((p) => (
          <li key={p.id} className={`queue-item status-${p.status} ${p.id === activeId ? 'active' : ''}`} onClick={() => onOpen(p.id)}>
            <div className="queue-row">
              <span className="queue-name">
                {p.kind === 'multi' ? '📁 ' : '🎬 '}
                {p.name}
              </span>
              <span className={`badge badge-${p.status}`}>{p.export?.status === 'running' ? 'exporting' : p.exportedAt ? 'exported' : STATUS_LABEL[p.status]}</span>
            </div>
            <div className="queue-meta">
              {p.clipCount > 1 && <span>{p.clipCount} clips · </span>}
              <span>{formatTime(p.totalDuration)}</span>
              {p.status === 'ready' && <span> · {p.cutCount} cuts</span>}
            </div>
            {(p.status === 'processing' || p.status === 'queued' || p.export?.status === 'running') && (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round((p.export?.status === 'running' ? p.export.progress : p.progress) * 100)}%` }} />
              </div>
            )}
            {p.status === 'error' && (
              <button
                className="btn small"
                onClick={(e) => {
                  e.stopPropagation();
                  void api.retry(p.id).then(refresh);
                }}
              >
                retry
              </button>
            )}
            {p.status === 'missing' && (
              <button
                className="btn small"
                onClick={(e) => {
                  e.stopPropagation();
                  void api.deleteProject(p.id).then(refresh);
                }}
              >
                remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
