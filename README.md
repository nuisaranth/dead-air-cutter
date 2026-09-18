# Dead Air Cutter

Local web app that removes silences ("dead air") from teaching videos. Drop recordings into an inbox folder, review the auto-detected cuts in a timeline editor, and export a re-encoded file. Nothing leaves your machine and originals are never modified.

## Requirements

- Node.js 20+ (tested with 24)
- ffmpeg and ffprobe on your PATH (tested with 9.0). Windows: `winget install Gyan.FFmpeg`

## Install

```
npm install
```

## Run

```
npm run dev
```

Then open http://127.0.0.1:5173. The API server listens on 127.0.0.1:5175. Both restart automatically when source files change.

To generate synthetic test clips with known silent gaps (7-10 s, 17-20 s, ...):

```
npm run sample          # single clip + a two-clip folder
npm run sample single   # only the single clip
```

Production-style run (build the client once, then a single process serves everything on port 5175):

```
npm run build
npm start
```

## Configuration

Edit `config.json` (paths are relative to the repo root):

| key | default | meaning |
| --- | --- | --- |
| `inbox` | `./media/inbox` | watched folder. A file = single-clip project, a sub-folder = multi-clip project |
| `output` | `./media/output` | exported videos |
| `done` | `./media/done` | originals are moved here after export |
| `data` | `./data` | project JSON files, audio analysis, preview proxies |
| `port` | `5175` | API port |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | binaries |
| `concurrency` | `1` | clips processed in parallel |
| `proxy.height` | `480` | preview proxy resolution |
| `proxy.encoder` | `auto` | `auto` tries `h264_amf`, `h264_nvenc`, `h264_qsv`, then `libx264` |
| `export.*` | libx264 / crf 18 / medium / 192k | export encoder, quality, audio bitrate; `resolution` and `fps` `auto` or e.g. `1920x1080` / `30` |
| `export.audioFormat` | `wav` | container for the **audio** button: `wav`, `mp3`, `m4a` or `flac` |
| `defaults` | -35 dB / 0.6 s / 0.15 s | initial silence threshold, min duration, padding |

## Workflow

1. Copy a video into the inbox, or a **folder** of clips to make one video from several recordings. It shows up in the queue on the left and is analysed in the background (audio envelope, silence pre-detection, low-res proxy). Folder clips are ordered by file name; a strip above the timeline shows the order, click a clip to jump to it and drag (or use ◀ ▶) to reorder. Different resolutions and frame rates are fine: the export scales everything to the largest clip and the highest fps. Already-analysed files that you move into a folder are recognised and keep their analysis and edits; remove the old entries from the list afterwards.
2. Open the project. Silences are red (cut). Adjust threshold / min duration / padding; the timeline updates instantly. Click a red block and press `K` to keep it.
3. Drag on the timeline to select a range, then `C` to cut it or `2` / `4` / `8` / `6` to speed it up 2-16× (16× mutes the audio, for "waiting for the program" stretches). The **volume** dropdown (or `M` to mute) attenuates, boosts or silences the selection without cutting it; green blocks on the timeline are volume changes. Each clip also has its own volume next to its name, which everything else adds on top of. Drag region edges to adjust. Preview playback skips cuts and plays sped-up ranges.
4. Press **export** (top right). A dialog shows the output length, resolution/fps and the target folder. The video is re-encoded from the originals (never from the proxy): every kept segment is cut on the source frame grid, sped-up ranges use `setpts`/`atempo`, and the pieces are joined losslessly. Progress shows in the header; **cancel** aborts and leaves nothing behind.
5. The result lands in `output/<name>.mp4` (a `(2)` suffix if it already exists) and the originals move to `done/`. The project stays in the queue as *exported* and can be reopened, re-edited and exported again.

Need only the sound? Press **audio**: it renders the edited soundtrack on its own (same cuts, clip order, speed ramps and volume changes as the video, no video encoding at all, so it is much faster) to `output/<name>.wav`. Nothing is moved and the project keeps its state. With a range selected on the timeline the button reads **audio ⧉** and renders just that range to `output/<name> selection.wav`; press `Esc` to clear the selection and get the whole timeline again.

Prefer to finish in DaVinci Resolve or Final Cut? Press **xml** instead: it writes `output/<name>.fcpxml` and `output/<name>.edl` that reference the original files (cuts, clip order and speed ramps included) without rendering or moving anything. Volume changes ride along in the `.fcpxml` only - the CMX3600 `.edl` format cannot express gain and silently drops it, so use the fcpxml when volume matters. In Resolve use File > Import > Timeline. CapCut cannot import XML/EDL; use the rendered mp4 there.

Export settings live in `config.json` under `export`: `encoder` (`libx264`, or `auto` to use the hardware encoder), `crf`, `preset`, `audioBitrate`, `resolution` (`auto` = largest clip, or e.g. `1920x1080`) and `fps` (`auto` = highest clip fps, or a number).

Edits are saved automatically to `data/projects/<id>.json`; close and reopen any time.

## Hotkeys

| key | action |
| --- | --- |
| `Space` | play / pause |
| `Enter` | play around the current cut |
| `,` / `.` | previous / next cut |
| `K` | toggle keep / cut on the selected cut |
| `C` | cut the selected range |
| `Delete` / `Backspace` | remove the selected manual cut, speed range or volume range (auto cut → keep) |
| `2` / `4` / `8` / `6` | speed up the selected range, or the clicked cut / kept-silence block, by 2×/4×/8×/16× (16× is muted); `1` resets. Same choices in the **speed** dropdown |
| `M` | mute the selected range or block; `0` removes the volume change. Other levels in the **volume** dropdown |
| `I` / `O` | trim clip head / tail at the playhead |
| `R` | review mode: after `K`, jump to the next cut and play around it |
| `Home` / `End` | jump to the start / end of the timeline |
| `←` / `→` | step one frame (`Shift` = 1 s) |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Esc` | clear selection |
| `Ctrl` + wheel | zoom timeline |

## Good to know

- **A volume boost cannot be heard while editing.** The browser caps `<video>` volume at 100 %, so a +6 dB range sounds unchanged in preview; the exported file really is louder. Turning volume *down* and muting preview correctly.
- **A clip's own volume draws nothing on the timeline** - only volume *ranges* get a green block. The clip chip turns green instead, or red with a bold **MUTED**, so check the chip if a whole clip sounds wrong.
- **Use Chrome for fast preview.** Firefox mutes playback above 5×, so 8× and 16× ranges are silent there. Exports are identical either way.
- Preview checks cut boundaries once per animation frame, so a few milliseconds of a cut can slip through. The export is frame-accurate.
- The **audio** export has no progress bar or cancel; with no video to encode it is usually done in seconds.
- Exports never overwrite: a second run of the same project lands as `<name> (2).mp4`.

## Layout

```
shared/   types + pure logic (silence detection, segment compiler) used by both sides
server/   Express API, folder watcher, ffmpeg jobs, video / audio / XML renderers
client/   React + Vite UI (wavesurfer.js timeline)
scripts/  make-sample.ts (synthetic test videos)
data/     runtime state (projects, analysis, proxies) - safe to delete, will be rebuilt
media/    default inbox / output / done folders
```

See `STATUS.md` for what is done and what is next.
