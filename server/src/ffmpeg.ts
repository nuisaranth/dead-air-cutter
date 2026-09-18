import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export const ENVELOPE_RATE = 100; // RMS windows per second
export const PEAKS_PER_SECOND = 20;
const SAMPLE_RATE = 8000;

export function parseFps(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.slice(-2000)}`));
    });
  });
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await runCapture(config.ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  const json = JSON.parse(out);
  const streams: any[] = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration) || Number(v?.duration) || 0;
  let fps = parseFps(v?.avg_frame_rate);
  if (!fps || !Number.isFinite(fps)) fps = parseFps(v?.r_frame_rate);
  let width = Number(v?.width) || 0;
  let height = Number(v?.height) || 0;
  const rotation = Math.abs(Number(v?.side_data_list?.find((s: any) => s.rotation != null)?.rotation ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return { duration, width, height, fps, hasAudio: !!a, hasVideo: !!v };
}

export interface Envelope {
  rmsDb: number[];
  peaks: number[];
}

/** Decode audio to 8 kHz mono PCM and compute an RMS (dB) envelope plus waveform peaks. */
export function extractEnvelope(
  file: string,
  duration: number,
  onProgress?: (p: number) => void,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    const child = spawn(config.ffmpegPath, args, { windowsHide: true });
    const WIN = SAMPLE_RATE / ENVELOPE_RATE;
    const PWIN = SAMPLE_RATE / PEAKS_PER_SECOND;
    const rmsDb: number[] = [];
    const peaks: number[] = [];
    let sumSq = 0;
    let count = 0;
    let peakMax = 0;
    let pcount = 0;
    let leftover: Buffer | null = null;
    let total = 0;
    let lastProgress = 0;
    let err = '';
    const totalSamples = Math.max(1, duration * SAMPLE_RATE);

    const pushRms = () => {
      const rms = Math.sqrt(sumSq / Math.max(1, count)) / 32768;
      const db = rms > 0 ? Math.max(-100, Math.min(0, 20 * Math.log10(rms))) : -100;
      rmsDb.push(Math.round(db));
      sumSq = 0;
      count = 0;
    };
    const pushPeak = () => {
      peaks.push(Math.round((peakMax / 32768) * 1000) / 1000);
      peakMax = 0;
      pcount = 0;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      let buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      leftover = usable < buf.length ? buf.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i);
        sumSq += s * s;
        count++;
        const abs = Math.abs(s);
        if (abs > peakMax) peakMax = abs;
        pcount++;
        if (count === WIN) pushRms();
        if (pcount === PWIN) pushPeak();
      }
      total += usable / 2;
      if (onProgress && total - lastProgress > SAMPLE_RATE * 5) {
        lastProgress = total;
        onProgress(Math.min(0.99, total / totalSamples));
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg envelope failed (${code}): ${err.slice(-2000)}`));
      if (count > 0) pushRms();
      if (pcount > 0) pushPeak();
      resolve({ rmsDb, peaks });
    });
  });
}

export interface RunOptions {
  duration?: number;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

function parseOutTime(line: string): number | null {
  if (line.startsWith('out_time_us=')) return Number(line.slice(12)) / 1e6;
  if (line.startsWith('out_time_ms=')) return Number(line.slice(12)) / 1e6; // ffmpeg reports micros here too
  if (line.startsWith('out_time=')) {
    const m = line.slice(9).match(/(\d+):(\d+):([\d.]+)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

/** Run ffmpeg with `-progress pipe:1`, reporting fractional progress when a duration is known. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args];
    const child = spawn(config.ffmpegPath, full, { windowsHide: true });
    let err = '';
    let buf = '';
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = parseOutTime(line.trim());
        if (t != null && opts.duration && opts.onProgress) {
          opts.onProgress(Math.max(0, Math.min(0.999, t / opts.duration)));
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 8000) err = err.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(-1500)}`));
    });
  });
}

let encoderPromise: Promise<string> | null = null;

/** Pick the proxy encoder: config value, or probe whether AMD/NVIDIA/Intel hardware H.264 works. */
export function resolveProxyEncoder(): Promise<string> {
  if (encoderPromise) return encoderPromise;
  encoderPromise = (async () => {
    if (config.proxy.encoder !== 'auto') return config.proxy.encoder;
    for (const enc of ['h264_amf', 'h264_nvenc', 'h264_qsv']) {
      try {
        await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=128x128:d=0.2', '-c:v', enc, '-f', 'null', '-']);
        console.log(`[ffmpeg] proxy encoder: ${enc}`);
        return enc;
      } catch {
        /* try next */
      }
    }
    console.log('[ffmpeg] proxy encoder: libx264 (no working hardware encoder)');
    return 'libx264';
  })();
  return encoderPromise;
}

export function videoEncoderArgs(encoder: string, quality: 'proxy' | 'export'): string[] {
  const exp = config.export;
  switch (encoder) {
    case 'h264_amf':
      return quality === 'proxy'
        ? ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '26']
        : ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(exp.crf), '-qp_p', String(exp.crf)];
    case 'h264_nvenc':
      return quality === 'proxy'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'constqp', '-qp', '26']
        : ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', String(exp.crf)];
    case 'h264_qsv':
      return quality === 'proxy'
        ? ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28']
        : ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(exp.crf)];
    default:
      return quality === 'proxy'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'fastdecode', '-sc_threshold', '0']
        : ['-c:v', 'libx264', '-preset', exp.preset, '-crf', String(exp.crf)];
  }
}

export interface ProxyOptions {
  height: number;
  sourceHeight: number;
  hasAudio: boolean;
  duration: number;
  onProgress?: (p: number) => void;
}

export async function makeProxy(file: string, out: string, opts: ProxyOptions): Promise<void> {
  const encoder = await resolveProxyEncoder();
  const tmp = `${out}.tmp.mp4`;
  const vf = opts.sourceHeight > opts.height ? ['-vf', `scale=-2:${opts.height}`] : ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
  const args = [
    '-y', '-i', file,
    '-map', '0:v:0', ...(opts.hasAudio ? ['-map', '0:a:0'] : []),
    ...vf,
    ...videoEncoderArgs(encoder, 'proxy'),
    '-g', '30', '-pix_fmt', 'yuv420p',
    ...(opts.hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'] : ['-an']),
    '-sn', '-dn', '-movflags', '+faststart',
    tmp,
  ];
  try {
    await runFfmpeg(args, { duration: opts.duration, onProgress: opts.onProgress });
  } catch (e) {
    if (encoder !== 'libx264') {
      // Hardware encoder failed on this file: fall back to software once.
      console.warn(`[ffmpeg] ${encoder} failed, retrying proxy with libx264: ${(e as Error).message}`);
      const idx = args.indexOf('-c:v');
      const sw = [...args.slice(0, idx), ...videoEncoderArgs('libx264', 'proxy'), ...args.slice(idx + videoEncoderArgs(encoder, 'proxy').length)];
      await runFfmpeg(sw, { duration: opts.duration, onProgress: opts.onProgress });
    } else {
      throw e;
    }
  }
  await fs.promises.rename(tmp, out);
}
