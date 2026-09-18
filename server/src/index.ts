import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AppConfigPublic, ProjectEdits } from '@app/shared';
import { ROOT, config, paths } from './config.js';
import { broadcast, sseHandler } from './events.js';
import * as projects from './projects.js';
import { enqueueProject, reprocessProject } from './queue.js';
import { exportAudio } from './audio.js';
import { cancelExport, isExporting, startExport } from './render.js';
import { startWatcher } from './watcher.js';
import { writeXmlExports } from './xml.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/api/config', (_req, res) => {
  const pub: AppConfigPublic = {
    inbox: config.inbox, output: config.output, done: config.done, defaults: config.defaults,
    export: { resolution: config.export.resolution, fps: config.export.fps, crf: config.export.crf, preset: config.export.preset, encoder: config.export.encoder, audioFormat: config.export.audioFormat },
  };
  res.json(pub);
});

app.get('/api/events', sseHandler);

app.get('/api/projects', async (_req, res) => {
  await projects.reconcileDone();
  const list = projects.all().map(projects.summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(list);
});

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const p = await projects.applyEdits(req.params.id, req.body as ProjectEdits);
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/projects/:id/reprocess', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  reprocessProject(p);
  broadcast({ type: 'project:update', project: p });
  res.json({ ok: true });
});

app.post('/api/projects/:id/retry', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  for (const c of p.clips) if (c.status === 'error') Object.assign(c, { status: 'pending', error: undefined });
  enqueueProject(p);
  res.json({ ok: true });
});

app.post('/api/projects/:id/export', async (req, res) => {
  let p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (isExporting(p.id)) return res.status(409).json({ error: 'export already running' });
  try {
    // The client sends its latest edits along so nothing pending in the autosave debounce is missed.
    if (req.body?.edits) p = await projects.applyEdits(p.id, req.body.edits as ProjectEdits);
    startExport(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/projects/:id/export-xml', async (req, res) => {
  let p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    if (req.body?.edits) p = await projects.applyEdits(p.id, req.body.edits as ProjectEdits);
    res.json(await writeXmlExports(p));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/projects/:id/export-audio', async (req, res) => {
  let p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    if (req.body?.edits) p = await projects.applyEdits(p.id, req.body.edits as ProjectEdits);
    const r = req.body?.range;
    const range = r && Number.isFinite(r.start) && Number.isFinite(r.end) ? { start: Math.max(0, r.start), end: r.end } : undefined;
    res.json(await exportAudio(p, range));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/projects/:id/export/cancel', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ ok: cancelExport(p) });
});

app.delete('/api/projects/:id', async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.location !== 'missing') return res.status(400).json({ error: 'only missing projects can be deleted' });
  await projects.remove(p.id);
  res.json({ ok: true });
});

app.use('/api/analysis', express.static(paths.analysis, { etag: true, maxAge: 0 }));
app.use('/proxies', express.static(paths.proxies, { acceptRanges: true }));

// Production: serve the built client.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/proxies')) {
      res.sendFile(path.join(dist, 'index.html'));
    } else next();
  });
}

await projects.loadAll();
startWatcher();
app.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${config.port}  (inbox: ${config.inbox})`);
  if (fs.existsSync(dist)) console.log(`[server] serving built client from ${dist}`);
});
