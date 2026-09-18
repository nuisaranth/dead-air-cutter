import { useCallback, useEffect, useState } from 'react';
import { useServerEvents } from './api';
import { QueuePanel } from './components/QueuePanel';
import { Editor } from './components/editor/Editor';
import { useEditor } from './store/editor';

function readHash(): string | null {
  const m = window.location.hash.match(/^#\/p\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [projectId, setProjectId] = useState<string | null>(readHash);
  const open = useEditor((s) => s.open);
  const close = useEditor((s) => s.close);
  const handleEvent = useEditor((s) => s.handleEvent);

  useEffect(() => {
    const onHash = () => setProjectId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (projectId) void open(projectId);
    else close();
  }, [projectId, open, close]);

  useServerEvents(useCallback((e) => handleEvent(e), [handleEvent]));

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>Dead Air Cutter</h1>
        </header>
        <QueuePanel activeId={projectId} onOpen={(id) => (window.location.hash = `#/p/${id}`)} />
      </aside>
      <main className="main">
        {projectId ? (
          <Editor key={projectId} />
        ) : (
          <div className="empty">
            <p>Drop a video (or a folder of clips) into the inbox folder, then pick a project on the left.</p>
          </div>
        )}
      </main>
    </div>
  );
}
