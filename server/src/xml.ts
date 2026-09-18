import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSegments, exportTarget, MUTE_DB, outputDuration, SPEED_MUTE_FROM, type Clip, type ProjectFile, type Segment } from '@app/shared';
import { config } from './config.js';
import * as projects from './projects.js';

/** Frame duration as a rational: 30 -> 1/30, 29.97 -> 1001/30000, 23.976 -> 1001/24000. */
function frameRational(fps: number): { num: number; den: number } {
  if (!fps || !Number.isFinite(fps)) return { num: 1, den: 30 };
  if (Math.abs(fps - Math.round(fps)) < 1e-3) return { num: 1, den: Math.round(fps) };
  const den = Math.round((fps * 1001) / 1000) * 1000;
  if (Math.abs(den / 1001 - fps) < 1e-2) return { num: 1001, den };
  // Arbitrary rate: use a 1/1000 s timebase rounded to the nearest frame.
  return { num: Math.round(1000 / fps), den: 1000 };
}

/** Seconds -> "N/Ds" aligned to whole frames of the given rate. */
function rt(seconds: number, fr: { num: number; den: number }): string {
  const frames = Math.round((seconds * fr.den) / fr.num);
  const n = frames * fr.num;
  return n === 0 ? '0s' : `${n}/${fr.den}s`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clipAbs(p: ProjectFile, c: Clip): string {
  return projects.clipAbs(p, c);
}

export function buildFcpxml(p: ProjectFile): string {
  const target = exportTarget(p.clips, config.export);
  const seqFr = frameRational(target.fps);
  const segments = compileSegments(p);
  const total = outputDuration(segments);

  const formats: string[] = [`  <format id="r0" name="FFVideoFormat${target.height}p${Math.round(target.fps)}" frameDuration="${seqFr.num}/${seqFr.den}s" width="${target.width}" height="${target.height}"/>`];
  const assets: string[] = [];
  const formatIdOf = new Map<string, string>();
  const assetIdOf = new Map<string, string>();
  p.clips.forEach((c, i) => {
    const fr = frameRational(c.fps || target.fps);
    const fid = `r${i + 1}`;
    const aid = `a${i + 1}`;
    formatIdOf.set(c.id, fid);
    assetIdOf.set(c.id, aid);
    formats.push(`  <format id="${fid}" name="FFVideoFormat${c.height}p${Math.round(c.fps)}" frameDuration="${fr.num}/${fr.den}s" width="${c.width}" height="${c.height}"/>`);
    const src = pathToFileURL(clipAbs(p, c)).href;
    assets.push(
      `  <asset id="${aid}" name="${esc(c.file)}" start="0s" duration="${rt(c.duration, fr)}" hasVideo="1" hasAudio="${c.hasAudio ? 1 : 0}" format="${fid}"${c.hasAudio ? ' audioSources="1" audioChannels="2" audioRate="48000"' : ''}>\n    <media-rep kind="original-media" src="${esc(src)}"/>\n  </asset>`,
    );
  });

  const items: string[] = [];
  let offsetFrames = 0;
  for (const seg of segments) {
    const clip = p.clips.find((c) => c.id === seg.clipId)!;
    const fr = frameRational(clip.fps || target.fps);
    const srcDur = seg.srcEnd - seg.srcStart;
    const outDur = srcDur / seg.speed;
    const outFrames = Math.max(1, Math.round((outDur * seqFr.den) / seqFr.num));
    const offset = offsetFrames === 0 ? '0s' : `${offsetFrames * seqFr.num}/${seqFr.den}s`;
    const durationAttr = seg.speed === 1 ? rt(srcDur, fr) : `${outFrames * seqFr.num}/${seqFr.den}s`;
    let body = '';
    // Gain travels as <adjust-volume>; a mute is -96 dB, the lowest value Final Cut accepts.
    const muted = seg.speed >= SPEED_MUTE_FROM || seg.gainDb <= MUTE_DB;
    if (clip.hasAudio && (muted || Math.abs(seg.gainDb) >= 0.01)) {
      body += '\n        <adjust-volume amount="' + (muted ? '-96' : seg.gainDb.toFixed(2)) + 'dB"/>';
    }
    if (seg.speed !== 1) {
      body +=
        `\n        <timeMap>` +
        `\n          <timept time="0s" value="${rt(seg.srcStart, fr)}" interp="linear"/>` +
        `\n          <timept time="${outFrames * seqFr.num}/${seqFr.den}s" value="${rt(seg.srcEnd, fr)}" interp="linear"/>` +
        `\n        </timeMap>`;
    }
    items.push(
      `      <asset-clip ref="${assetIdOf.get(clip.id)}" name="${esc(clip.file)}" offset="${offset}" start="${rt(seg.srcStart, fr)}" duration="${durationAttr}" format="${formatIdOf.get(clip.id)}" tcFormat="NDF"${clip.hasAudio ? ' audioRole="dialogue"' : ''}>${body}${body ? '\n      ' : ''}</asset-clip>`,
    );
    offsetFrames += seg.speed === 1 ? Math.round((srcDur * seqFr.den) / seqFr.num) : outFrames;
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.9">',
    '<resources>',
    ...formats,
    ...assets,
    '</resources>',
    '<library>',
    '  <event name="Dead Air Cutter">',
    `    <project name="${esc(p.name)}">`,
    `      <sequence format="r0" duration="${rt(total, seqFr)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '      <spine>',
    ...items,
    '      </spine>',
    '      </sequence>',
    '    </project>',
    '  </event>',
    '</library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

function timecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const totalFrames = Math.round(seconds * rate);
  const f = totalFrames % rate;
  const s = Math.floor(totalFrames / rate);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(f)}`;
}

/** CMX3600 EDL. Speed changes use M2 lines; clip names via FROM CLIP NAME comments (Resolve/Premiere match on them). */
export function buildEdl(p: ProjectFile): string {
  const target = exportTarget(p.clips, config.export);
  const fps = target.fps;
  const segments: Segment[] = compileSegments(p);
  const lines = [`TITLE: ${p.name}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  segments.forEach((seg, i) => {
    const clip = p.clips.find((c) => c.id === seg.clipId)!;
    const outDur = (seg.srcEnd - seg.srcStart) / seg.speed;
    const n = String(i + 1).padStart(3, '0');
    const srcIn = timecode(seg.srcStart, fps);
    const srcOut = timecode(seg.srcEnd, fps);
    const recIn = timecode(rec, fps);
    const recOut = timecode(rec + outDur, fps);
    lines.push(`${n}  AX       AA/V  C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    if (seg.speed !== 1) lines.push(`M2   AX             ${(fps * seg.speed).toFixed(1).padStart(6, '0')}                ${srcIn}`);
    lines.push(`* FROM CLIP NAME: ${clip.file}`);
    lines.push(`* SOURCE FILE: ${clipAbs(p, clip)}`);
    lines.push('');
    rec += outDur;
  });
  return lines.join('\r\n');
}

export interface XmlExportResult {
  fcpxml: string;
  edl: string;
}

export async function writeXmlExports(p: ProjectFile): Promise<XmlExportResult> {
  if (p.location === 'missing') throw new Error('source files are missing');
  if (!p.clips.length || p.clips.some((c) => c.status !== 'ready')) throw new Error('clips are still processing');
  if (!compileSegments(p).length) throw new Error('nothing to export: every part of the video is cut');
  const fcpxml = path.join(config.output, `${p.name}.fcpxml`);
  const edl = path.join(config.output, `${p.name}.edl`);
  await fs.promises.writeFile(fcpxml, buildFcpxml(p), 'utf8');
  await fs.promises.writeFile(edl, buildEdl(p), 'utf8');
  return { fcpxml, edl };
}
