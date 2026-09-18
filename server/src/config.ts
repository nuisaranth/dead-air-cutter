import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectParams } from '@app/shared';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AppConfig {
  inbox: string;
  output: string;
  done: string;
  data: string;
  port: number;
  ffmpegPath: string;
  ffprobePath: string;
  concurrency: number;
  proxy: { height: number; encoder: 'auto' | string };
  export: {
    encoder: string;
    crf: number;
    preset: string;
    audioBitrate: string;
    resolution: 'auto' | string;
    fps: 'auto' | number;
    /** Container for the audio-only export: wav, mp3, m4a or flac. */
    audioFormat: string;
  };
  defaults: DetectParams;
}

const DEFAULTS: AppConfig = {
  inbox: './media/inbox',
  output: './media/output',
  done: './media/done',
  data: './data',
  port: 5175,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  concurrency: 1,
  proxy: { height: 480, encoder: 'auto' },
  export: { encoder: 'libx264', crf: 18, preset: 'medium', audioBitrate: '192k', resolution: 'auto', fps: 'auto', audioFormat: 'wav' },
  defaults: { thresholdDb: -35, minDuration: 0.6, padding: 0.15 },
};

function loadConfig(): AppConfig {
  const file = path.join(ROOT, 'config.json');
  let raw: Partial<AppConfig> = {};
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    console.warn(`[config] ${file} not found, using defaults`);
  }
  const cfg: AppConfig = {
    ...DEFAULTS,
    ...raw,
    proxy: { ...DEFAULTS.proxy, ...(raw.proxy ?? {}) },
    export: { ...DEFAULTS.export, ...(raw.export ?? {}) },
    defaults: { ...DEFAULTS.defaults, ...(raw.defaults ?? {}) },
  };
  for (const key of ['inbox', 'output', 'done', 'data'] as const) {
    cfg[key] = path.resolve(ROOT, cfg[key]);
    fs.mkdirSync(cfg[key], { recursive: true });
  }
  for (const sub of ['projects', 'analysis', 'proxies', 'tmp']) {
    fs.mkdirSync(path.join(cfg.data, sub), { recursive: true });
  }
  return cfg;
}

export const config = loadConfig();

export const paths = {
  projects: path.join(config.data, 'projects'),
  analysis: path.join(config.data, 'analysis'),
  proxies: path.join(config.data, 'proxies'),
  tmp: path.join(config.data, 'tmp'),
  analysisFile: (clipId: string) => path.join(config.data, 'analysis', `${clipId}.json`),
  proxyFile: (clipId: string) => path.join(config.data, 'proxies', `${clipId}.mp4`),
  projectFile: (id: string) => path.join(config.data, 'projects', `${id}.json`),
};
