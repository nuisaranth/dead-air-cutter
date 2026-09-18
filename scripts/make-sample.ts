// Generates synthetic test videos with known silent gaps into the inbox.
// Audio: 7 s of tone, 3 s of near-silence (noise floor ~ -54 dBFS), repeating every 10 s.
// Expected silences (before padding): 7-10, 17-20, 27-30, ...
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const inbox = path.resolve(ROOT, cfg.inbox ?? './media/inbox');
const ffmpeg = cfg.ffmpegPath ?? 'ffmpeg';

interface Spec {
  out: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Tone frequency, so clips in a folder are distinguishable by ear. */
  freq: number;
}

function generate(spec: Spec): void {
  fs.mkdirSync(path.dirname(spec.out), { recursive: true });
  const audioExpr = `0.4*sin(2*PI*${spec.freq}*t)*(0.6+0.4*sin(2*PI*3*t))*lt(mod(t,10),7)+0.004*(random(0)-0.5)`;
  const args = [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.duration}`,
    '-f', 'lavfi', '-i', `aevalsrc='${audioExpr}':s=48000:d=${spec.duration}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    spec.out,
  ];
  const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error(`ffmpeg failed for ${spec.out}`);
    process.exit(1);
  }
  console.log(`wrote ${path.relative(ROOT, spec.out)}  (${spec.width}x${spec.height}@${spec.fps}, ${spec.duration}s)`);
}

const only = process.argv[2]; // "single" | "multi" | undefined (both)

if (!only || only === 'single') {
  generate({ out: path.join(inbox, 'lesson-single.mp4'), width: 1280, height: 720, fps: 30, duration: 60, freq: 440 });
}
if (!only || only === 'multi') {
  const dir = path.join(inbox, 'lesson-multi');
  generate({ out: path.join(dir, '01-intro.mp4'), width: 1280, height: 720, fps: 30, duration: 20, freq: 330 });
  generate({ out: path.join(dir, '02-main.mp4'), width: 1920, height: 1080, fps: 25, duration: 30, freq: 550 });
}
console.log('Expected silences per clip: 7-10 s, 17-20 s, 27-30 s, ... (shrunk by padding on each side)');
