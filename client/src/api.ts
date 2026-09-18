import { useEffect } from 'react';
import type { Analysis, AppConfigPublic, ProjectEdits, ProjectFile, ProjectSummary, ServerEvent } from '@app/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => request<AppConfigPublic>('/api/config'),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  project: (id: string) => request<ProjectFile>(`/api/projects/${id}`),
  saveEdits: (id: string, edits: ProjectEdits) =>
    request<ProjectFile>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(edits) }),
  analysis: (clipId: string) => request<Analysis>(`/api/analysis/${clipId}.json`),
  reprocess: (id: string) => request<{ ok: true }>(`/api/projects/${id}/reprocess`, { method: 'POST' }),
  retry: (id: string) => request<{ ok: true }>(`/api/projects/${id}/retry`, { method: 'POST' }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  startExport: (id: string, edits: ProjectEdits) =>
    request<{ ok: true }>(`/api/projects/${id}/export`, { method: 'POST', body: JSON.stringify({ edits }) }),
  exportXml: (id: string, edits: ProjectEdits) =>
    request<{ fcpxml: string; edl: string }>(`/api/projects/${id}/export-xml`, { method: 'POST', body: JSON.stringify({ edits }) }),
  exportAudio: (id: string, edits: ProjectEdits, range?: { start: number; end: number }) =>
    request<{ path: string; duration: number; segments: number; partial: boolean }>('/api/projects/' + id + '/export-audio', {
      method: 'POST',
      body: JSON.stringify({ edits, range }),
    }),
  cancelExport: (id: string) => request<{ ok: true }>(`/api/projects/${id}/export/cancel`, { method: 'POST' }),
  proxyUrl: (clipId: string) => `/proxies/${clipId}.mp4`,
};

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data) as ServerEvent;
      for (const l of listeners) l(evt);
    } catch {
      /* ignore malformed */
    }
  };
}

/** Subscribe to server-sent events for the lifetime of the component. */
export function useServerEvents(handler: Listener): void {
  useEffect(() => {
    ensureSource();
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [handler]);
}
