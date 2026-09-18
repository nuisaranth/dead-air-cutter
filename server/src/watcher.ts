import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { isVideoFile } from '@app/shared';
import { config } from './config.js';
import * as projects from './projects.js';
import { enqueueProject } from './queue.js';

const timers = new Map<string, NodeJS.Timeout>();

/** Coalesce bursts of file events for the same project into one scan. */
function debounce(key: string, fn: () => Promise<void>, ms = 400): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn().catch((e) => console.error(`[watcher] ${key}: ${(e as Error).message}`));
    }, ms),
  );
}

async function scanSingle(rel: string): Promise<void> {
  const abs = path.join(config.inbox, rel);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    await projects.markMissing(rel);
    return;
  }
  const p = await projects.upsertFromScan(rel, 'single', [{ name: rel, size: st.size, mtimeMs: st.mtimeMs }]);
  enqueueProject(p);
}

async function scanFolder(folder: string): Promise<void> {
  const abs = path.join(config.inbox, folder);
  let names: string[];
  try {
    names = await fs.promises.readdir(abs);
  } catch {
    await projects.markMissing(folder);
    return;
  }
  const files: projects.ScanFile[] = [];
  for (const name of names) {
    if (!isVideoFile(name)) continue;
    try {
      const st = await fs.promises.stat(path.join(abs, name));
      if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  if (!files.length) {
    await projects.markMissing(folder);
    return;
  }
  const p = await projects.upsertFromScan(folder, 'multi', files);
  enqueueProject(p);
}

function route(abs: string, removed: boolean): void {
  const rel = path.relative(config.inbox, abs);
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) {
    if (!isVideoFile(parts[0])) return;
    debounce(`single:${rel}`, () => (removed ? projects.markMissing(rel) : scanSingle(rel)));
  } else if (parts.length === 2) {
    if (!isVideoFile(parts[1])) return;
    debounce(`folder:${parts[0]}`, () => scanFolder(parts[0]));
  }
}

export function startWatcher(): void {
  const watcher = chokidar.watch(config.inbox, {
    depth: 1,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    ignored: (p, stats) => !!stats?.isFile() && !isVideoFile(path.basename(p)),
  });
  watcher
    .on('add', (p) => route(p, false))
    .on('change', (p) => route(p, false))
    .on('unlink', (p) => route(p, true))
    .on('addDir', (p) => {
      const rel = path.relative(config.inbox, p);
      if (rel && !rel.includes(path.sep)) debounce(`folder:${rel}`, () => scanFolder(rel));
    })
    .on('unlinkDir', (p) => {
      const rel = path.relative(config.inbox, p);
      if (rel && !rel.includes(path.sep)) debounce(`folder:${rel}`, () => projects.markMissing(rel));
    })
    .on('error', (e) => console.error('[watcher]', e))
    .on('ready', async () => {
      // Projects whose source disappeared while the server was down.
      for (const p of projects.all()) {
        if (p.location === 'inbox' && !fs.existsSync(projects.sourceAbs(p))) await projects.markMissing(p.sourcePath);
      }
      await projects.reconcileDone();
      console.log(`[watcher] watching ${config.inbox}`);
    });
}
