import { useCallback, useEffect, useState } from 'react';
import { useServerEvents } from './api';
import { GuideView } from './components/GuideView';
import { QueuePanel } from './components/QueuePanel';
import { Editor } from './components/editor/Editor';
import { useEditor } from './store/editor';

type Route = { projectId: string | null; guide: boolean };

function readHash(): Route {
  if (window.location.hash === '#/guide') return { projectId: null, guide: true };
  const m = window.location.hash.match(/^#\/p\/([\w-]+)/);
  return { projectId: m ? m[1] : null, guide: false };
}

export function App() {
  const [route, setRoute] = useState<Route>(readHash);
  const { projectId, guide } = route;
  const open = useEditor((s) => s.open);
  const close = useEditor((s) => s.close);
  const handleEvent = useEditor((s) => s.handleEvent);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
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
          <a href="#/guide" className={`sidebar-guide-link${guide ? ' active' : ''}`}>
            คู่มือ AI Skills
          </a>
        </header>
        <QueuePanel activeId={projectId} onOpen={(id) => (window.location.hash = `#/p/${id}`)} />
      </aside>
      <main className="main">
        {guide ? (
          <GuideView onBack={() => (window.location.hash = '')} />
        ) : projectId ? (
          <Editor key={projectId} />
        ) : (
          <div className="empty">
            <p>Drop a video (or a folder of clips) into the inbox folder, then pick a project on the left.</p>
            <p>
              <a href="#/guide" className="empty-guide-link">
                เปิดคู่มือใช้งาน AI Video Editing Pipeline &amp; Skills →
              </a>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
