# STATUS

Last updated: 2026-09-18 (phases 1-5 complete: silence detection, editor, export, multi-clip, and audio export + volume/mute/gain)

## Environment
- Windows 11, Node 24.14, npm 11, ffmpeg/ffprobe 9.0 (gyan.dev full build), AMD Radeon 780M (h264_amf works and is used for proxies).
- Versions installed: express 5.2, chokidar 5.0, react 19.3, vite 8.3, wavesurfer.js 7.12, zustand 5.0, tsx 4.23, typescript 7.0.
- Run: `npm install` then `npm run dev` -> http://127.0.0.1:5173 (API on 5175). `npm run sample` writes test clips into the inbox.

## Done

### Phase 1 - watch folder + silence detection (single clip)
- npm workspaces: `shared` (types + pure logic), `server` (Express 5 + chokidar + ffmpeg), `client` (React + Vite + wavesurfer.js).
- `config.json`: inbox/output/done/data paths, port, encoder settings, detection defaults.
- Watcher (`server/src/watcher.ts`): top-level video = single project, sub-folder = multi project (natural filename order), `awaitWriteFinish` so half-copied files are ignored, removed sources -> `missing`, re-added ones come back, replaced files (size/mtime fingerprint) are reprocessed.
- Queue (`server/src/queue.ts`): probe -> audio envelope (RMS dB @ 100/s + peaks @ 20/s in `data/analysis/<clipId>.json`) -> silence pre-detect -> 480p proxy (`data/proxies/<clipId>.mp4`, keyframe every 1 s, h264_amf with libx264 fallback). Progress via SSE `/api/events`.
- Silence detection is pure TS (`shared/src/silence.ts`) and runs in the browser on the envelope, so slider changes are instant. Re-detection carries over "keep" decisions by overlap.
- Verified with `npm run sample`: gaps at 7-10 s etc. detect as 7.15-9.85 with 0.15 s padding.

### Phase 2 - editor + non-destructive JSON
- Playback engine (`client/src/engine/playback.ts`): rAF loop on the proxy `<video>`; skips cut ranges (incl. trims), sets `playbackRate` inside speed ranges, honours `stopAt` for review playback. Verified: 6->11 s plays in 2.5 s wall time with the 7.15-9.85 cut skipped; rate 4 inside a 4x range.
- Timeline (`client/src/components/editor/Timeline.tsx`): wavesurfer regions for cuts (red / gray when kept), speed ranges (amber, labelled), trims (dark red), selection (blue dashed, draggable/resizable). Drag on the waveform = selection. Drag region edges = resize (`moveRange`). White tabs at clip edges = trim handles (pointer drag). Ctrl+wheel zoom, playhead overlay with auto-scroll.
- Tools (transport bar + hotkeys in `client/src/hotkeys.ts`): cut selection (C), speed 2/4/8 on selection or selected speed range, 1 = normal, keep/cut toggle (K), delete, prev/next cut (, .), play around cut (Enter, 1.5 s context), trim head/tail at playhead (I/O), frame step (arrows), Home/End, Esc, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.
- Review panel (`ReviewPanel.tsx`): sorted cut list with keep/cut buttons, click = jump, double-click = play around; "review mode" (R) auto-advances to the next cut after K.
- Undo/redo: snapshot stack (200 steps), slider drags / region drags / trim drags coalesce into one step.
- Non-destructive: edits autosave (600 ms debounce, keepalive flush on unload) to `data/projects/<id>.json` via `PUT /api/projects/:id`; originals untouched; reopening restores everything.
- `window.__editor` exposes the zustand store in the browser console for debugging.
- Post-testing refinements: waveform is normalized (quiet recordings still show a visible waveform); "auto" button next to the threshold slider sets it to noise floor (10th percentile) + 5 dB; review panel has "keep cuts shorter than X s", "cut all" and "keep all".

### Phase 3 - export
- `server/src/render.ts`: `POST /api/projects/:id/export` (the client sends its current edits in the body so nothing pending in the autosave debounce is lost), `POST .../export/cancel`, progress via SSE `export:progress` (throttled to ~3/s), state persisted in the project JSON (`export`, `exportedAt`).
- Pipeline: every kept segment is encoded separately from the ORIGINAL with `-ss/-t` before `-i` (accurate seek + full re-encode). Segment boundaries are snapped to the source frame grid so each intermediate `.mov` holds an exact number of frames and exactly as much PCM audio; the seek starts 0.2 frame early and the audio is trimmed by the same amount so both streams begin on the same frame. Filters: `setpts=(PTS-STARTPTS)/speed`, `scale`+`pad` to the target size, `fps=<target>`, `atempo` chain for speed. Then the concat demuxer joins them with video stream copy and audio -> AAC (config bitrate), `+faststart`. Temp files in `data/tmp/export-<id>/`, removed on success, error and cancel.
- Target resolution/fps (`shared/src/exportTarget.ts`): largest clip / highest fps unless `config.export.resolution` / `fps` override. Clips without audio get a silent track so multi-clip joins always have audio.
- After success the output goes to `output/<name>.mp4` (unique name), the originals move to `done/` (`location: 'done'`, project stays openable and re-exportable; cross-drive move falls back to copy+delete). The location flips before the move so the watcher's unlink event does not mark the project missing.
- Client: **export** button in the header opens `ExportDialog.tsx` (output length, segment count, target video/audio settings, destination). While running the header shows a progress bar + message + cancel; afterwards "exported ✓ file", "export failed: ..." or "export cancelled". Queue badge shows *exporting* / *exported*.
- Verified on the 60 s sample (5 cuts, one kept silence, one 2x range): 7 segments, output 45.867 s vs 45.85 s compiled (+1 frame from grid snapping), 1376 frames with every frame interval exactly 1/30 s, audio and video tracks the same length and both starting at 0, no silent gaps except the intended 0.15 s padding on each side of every cut at exactly the predicted positions, temp folder cleaned, original in `done/`, cancel after 1 s -> `cancelled`, no output file, no temp files. Export took ~7 s for 46 s of 720p output (libx264 medium, crf 18).
- Verified on a real recording ("2026-08-09 20-29-13", 6:26, 720p30, 46 cuts): 90 segments, output 210.933 s vs 210.870 s compiled (+2 frames over 90 joins), 6328 frames at a constant 30 fps, 298 MB source -> 18 MB output, export took 44 s. Original moved to `media/done/`, result in `media/output/`.

### Phase 4 - multi-clip
- `ClipList.tsx`: order strip above the timeline (only for projects with 2+ clips). Each chip shows index, file name, duration, resolution @ fps and processing state; the clip under the playhead is highlighted. Click = jump to the clip start, drag a chip onto another to reorder, or use the ◀ ▶ buttons. Reordering is an undoable edit (`reorderClips`) and autosaves like everything else; cuts/speeds/trims are clip-local so they move with their clip.
- Timeline: a dashed white line at every clip start plus a `n. file` label, positioned as a percentage so they follow zoom.
- Playback across clips: the engine and the `<video>` `ended` handler hop to the next clip's start (`setPlayhead(t, seek, keepStop)` keeps a pending `stopAt` so review playback still stops where asked). The single `<video>` element swaps `src`, so there is a short hiccup at the boundary; export is unaffected.
- Export normalization was already in from Phase 3 (`exportTarget`: largest resolution, highest fps; `scale` + `pad` + `fps` per segment).
- Verified on `npm run sample multi` (01-intro 1280x720@30 20 s, 02-main 1920x1080@25 30 s, 5 cuts): review playback 18 -> 23 s crossed the boundary at 20 s, switched proxy src, skipped the 17.15-19.85 cut and stopped at 23.00 (3.2 s wall time); store reorder swapped the strip order and undo restored it; export produced 1920x1080 @ constant 30 fps, 36.3 s vs 36.2 s compiled (+3 frames: the 25 fps clip's segments snap to its own frame grid and round to 30 fps), 1088 equal frame intervals, residual padding silences exactly at the predicted join points, folder moved to `media/done/lesson-multi`, export took 10 s.

### Extras (after Phase 4)
- **16× speed** (button + key `6`) for "waiting for the program" stretches. `SpeedFactor` is now `2 | 4 | 8 | 16`; ranges at or above `SPEED_MUTE_FROM` (16, in `shared/src/types.ts`) get `volume=0` on export and `muted` in preview, since atempo-ed speech is unintelligible there anyway. Preview clamps `playbackRate` to 16 (Chrome throws above that). XML/EDL need no change: the timeMap / `M2` line take any factor. Adding 32× later is a one-line type change plus a dropdown entry, but preview would then run at half the real rate.
- Speed UI is a **speed** dropdown (off / 2× / 4× / 8× / 16× muted) instead of five buttons, chosen by the user for toolbar space; it shows the selected range’s factor and is disabled without a target. `.transport` now wraps onto a second line instead of clipping on narrow windows.
- Speed on a clicked block: `2`/`4`/`8` (and the buttons) also work when a cut / kept-silence block is selected, creating a speed range over exactly that span and selecting it; `1` clears it. Needed because wavesurfer swallows a drag that starts on any region (`stopPropagation` in its draggable helper), so a selection could not be drawn on top of a long kept silence - the main case for "do not cut, speed up 8x".
- **XML / EDL export** (`server/src/xml.ts`, `POST /api/projects/:id/export-xml`, **xml** button in the header): writes `output/<name>.fcpxml` (FCPXML 1.9, one `<asset>` per clip pointing at the original file via `file:///` URL, one `<asset-clip>` per kept segment, sped-up segments carry a linear `<timeMap>`; all times are frame-aligned rationals like `215/30s`, sequence format = the same target as the render) and `output/<name>.edl` (CMX3600, `AA/V` events, `M2` lines for speed, `FROM CLIP NAME` / `SOURCE FILE` comments). Nothing is rendered or moved. DaVinci Resolve: File > Import > Timeline and pick the `.fcpxml` (or `.edl`); relink if asked. CapCut has no XML/EDL import, so only the rendered mp4 works there. Verified: well-formed XML, offsets/durations sum to the compiled output length, timeMap for the 2x range maps 0..0.5 s -> 22..23 s.
- **Moved files are not reprocessed** (`projects.adoptFromDonor`): a file moved within the inbox (e.g. from the root into a folder to join clips) or back from `done/` keeps its size:mtime fingerprint, so when a new clip's fingerprint matches a ready clip of another project (including one now `missing`), its analysis JSON and proxy are copied under the new clip id and its cuts/keeps/speeds/trims (and, for a fresh project, the detection params) are carried over. The new project is `ready` immediately. Verified: `done/lesson-single.mp4` moved into `inbox/reuse-test/` -> project ready in the same scan with 5 cuts, 1 keep and the 2x range intact. Remove the old `missing` entries afterwards; if they are removed *before* the move, nothing can be reused (orphan analysis/proxy files are not indexed).
- Timeline zoom survives edits: the wavesurfer instance is keyed on clip identity + duration (not on the edited clip objects), so toggling cuts / changing params no longer rebuilds it; when it *is* rebuilt (analysis arrives, clip added) the last zoom level and scroll position are restored. Verified headless: 746 px fit -> 2839 px zoomed, unchanged after a cut toggle and a param change.
- Originals deleted from `done/` by hand: `projects.reconcileDone()` (on `GET /api/projects` and at watcher start) flips such projects to `missing`, which shows the *remove* button in the queue; putting the file back flips them to `done` again. Verified by moving `done/lesson-single.mp4` away and back.

### Phase 5 - audio (export + volume/mute/gain)
- **Audio-only export** (`server/src/audio.ts`, `POST /api/projects/:id/export-audio`, **audio** button in the header): renders the edited soundtrack alone - same `compileSegments` output, same frame-grid snapping, same 0.2-frame lead trim, same `atempo`/`volume` chain as `render.ts`, but `-vn` and no video filters, so it stays sample-aligned with the mp4 and skips x264 entirely. Intermediates are wav, joined with the concat demuxer, then encoded per `config.export.audioFormat` (`wav` pcm_s16le / `mp3` libmp3lame / `m4a` aac / `flac`). Like the XML export it **renders only**: nothing moves to `done/` and `location` / `exportedAt` are untouched.
- **Gain model** (`shared/src/types.ts`): `Clip.gainDb` for a whole clip plus `GainRange { clipId, start, end, db }` layered on top; the two add. `MUTE_DB` (-60) or lower means a hard mute (`volume=0`), `GAIN_MAX_DB` is +12, and `GAIN_STEPS` drives both dropdowns. `compileSegments` now splits kept ranges at gain boundaries as well as speed boundaries and carries the summed `Segment.gainDb`; `gainRangeFits` mirrors `speedRangeFits`.
- **Export** (`render.ts`): `volumeFilters()` is shared with `audio.ts` and emits `volume=0` for a mute or a >=16x speed range, `volume=<db>dB` otherwise, nothing at 0 dB.
- **Preview** (`playback.ts`): sets `v.volume` from `dbToLinear(clip gain + range gain)` and `v.muted` at zero. Attenuation and mute work; **boost above 0 dB cannot be previewed** because `<video>.volume` is capped at 1 (export boosts freely). A Web Audio `GainNode` would lift that cap if it ever matters.
- **Clip volume is flagged**: a chip whose clip gain is not 0 dB turns green (or red, with the dropdown reading **MUTED** in bold, when it is muted). A whole-clip gain draws nothing on the timeline, so without this the only symptom of an accidental mute was silence in the finished export. The chip dropdown spells out "vol -6 dB" / "MUTED" while the transport one stays terse.
- **UI**: **volume** dropdown in the transport bar (off / mute / -12 / -6 / -3 / +3 / +6 / +12 dB) acting on the selection, a selected gain range, or a clicked cut / speed block; `M` mutes and `0` clears. Green regions on the timeline, labelled with the level, plus a legend entry. `ClipList` now renders for single-clip projects too (previously 2+ only) to carry the per-clip volume select.
- **Persistence**: `gains` and `gainDb` flow through `ProjectEdits`, `applyEdits` (clamped to the dB range), the undo snapshots, and `adoptFromDonor`; `loadAll` backfills both on project files written before this phase. Also fixed: `applyEdits` clamped `factor` to 2/4/8 and silently downgraded a 16x range to 2x.
- **XML**: FCPXML segments carry `<adjust-volume amount="...dB"/>` (-96 dB for a mute). **EDL cannot represent gain** and silently drops it.
- **Partial (selection) audio export**: the request may carry a `range` in OUTPUT seconds. `clampToRange` keeps the overlapping segments, re-cuts the two that straddle the edges (output seconds map back to source through the segment's speed factor) and rebases the output times to zero; the file gets a ` selection` suffix and the result reports `partial: true`. The client converts its source-timeline selection with `sourceToOutput` before sending, and the button reads **audio ⧉** while a selection exists.
- Verified: a 10-20 s range export of `lesson-single` produced exactly 10.000 s from 4 of the 7 segments, and subtracting it from the same window of the full export gave **digital silence** (max level 0.000000, RMS -inf dB over all 480000 samples) - the partial render is sample-identical to the full one.
- Verified end to end on `lesson-single` (60 s, 6 cuts, one 2x range) with a -60 dB mute over 20-25 s and +6 dB over 30-35 s: `export-audio` produced an 11-segment 45.87 s wav matching the compiled 45.85 s, `silencedetect` showed a 4.8 s silent span where the mute landed against the usual 0.3 s padding silences elsewhere, the originals stayed put and the project state was unchanged. ffmpeg `volume=0` and `volume=-6.00dB` chains verified separately.

### Phase 5 planning notes (superseded by the section above)
Scope agreed 2026-09-18: extract the audio as its own file, and control loudness per clip and per range. AI source separation (splitting voice from music/noise with Demucs/Spleeter) is explicitly **out of scope** - it needs Python + PyTorch + a ~300 MB model, runs 5-10x slower than realtime on CPU (PyTorch ROCm does not support Windows, so the 780M cannot help) and would force a re-analysis of every envelope. `afftdn` (5d) covers the realistic need without any new dependency.

**5a - audio-only export (the main ask)**
- New `POST /api/projects/:id/export-audio` in `index.ts`, sitting next to `export-xml`; **audio** button in the header next to **xml**.
- Two things a user could mean; build the edited one, it is the useful one:
  - *edited audio* = the soundtrack of what the video export would produce (cuts, clip order, speed ramps applied). Reuse `compileSegments` exactly as `render.ts` does, but drop every video filter and encode `-vn` straight to the target format. No x264 pass at all, so this is far faster than a video export - roughly I/O bound.
  - *raw per-clip audio* = one file per source, `ffmpeg -i src -vn -c:a copy`. Trivial; add later as a checkbox if wanted.
- Reuse the existing segment machinery: same frame-grid snapping and the same `atempo` chain, so the result stays sample-aligned with the mp4 and the two can be swapped in a NLE.
- Output via `uniquePath` to `output/<name>.wav` (or `.mp3`/`.m4a`). New `export.audioFormat` key in `config.json`.
- Like the XML export: **render only, move nothing** - the originals stay in the inbox and the project keeps its state. Do not call `moveToDone`.
- Progress via the existing SSE `export:progress`; it can share `startExport`'s state machine or get its own - decide when implementing.

**5b - per-clip gain (smallest useful step)**
- `Clip` gets `gainDb: number` (0 = unchanged). No change to `compileSegments` at all.
- `render.ts`: append `volume=<db>dB` to the `af` chain in `encodeSegment`.
- `playback.ts`: set `v.volume` from the clip's gain when the clip changes.
- UI: a small dB field on the `ClipList` chip - multi-clip recordings are rarely levelled the same.

**5c - gain / mute ranges (mirrors the existing SpeedRange pattern)**
- `GainRange { id, clipId, start, end, db }` in `types.ts`, added to `ProjectFile` and `ProjectEdits`; `db: -Infinity` (or a `mute` flag) = silence. Reuse `speedRangeFits` for overlap.
- `compileSegments` currently splits kept ranges at speed boundaries only - add the gain boundaries to the same point set and carry `gainDb` on `Segment`. This is the only non-trivial logic change in the whole phase.
- `render.ts`: `volume` per segment (order vs `atempo` does not matter for plain gain).
- `playback.ts`: set `v.volume` per range the same way `playbackRate` is set today.
- Timeline: a fourth region colour + store actions (`gainSelection`, reuse `removeRange`) + hotkeys. Most of the work is UI, not logic.
- Caveat: `<video>.volume` is clamped to 0..1, so **preview can attenuate and mute but not boost**. Boost above 0 dB needs a Web Audio `GainNode` via `createMediaElementSource` (bound to the element, so the proxy `src` swap at clip boundaries is fine). Export is unaffected - ffmpeg boosts freely.
- Caveat: FCPXML can carry this as `<adjust-volume>`, but **CMX3600 EDL cannot** - gain is silently lost in the `.edl`. Note it in the export dialog.

**5d - fades and noise reduction**
- `afade` on segment edges; a natural extension once 5c's ranges exist.
- `afftdn` (built into ffmpeg, no new dependency) in the analysis pass in `queue.ts`, so the RMS envelope is computed from denoised audio. Aircon / fan / hum hurt silence detection today; this should make the threshold slider behave far better without changing the exported audio. Optional follow-up: offer the same filter on export as a checkbox.

**Related, not scheduled:** selecting between multiple audio streams in one file (`-map 0:a:N`, needs `probe` to list the streams first).

## Decided against

### Separate audio / video tracks (would have been phase 6) - NOT DOING, decided 2026-09-18
Detaching the audio so it can slide against the picture (L-cuts and J-cuts, audio from one clip under another clip's video, or an imported music / voiceover track) was considered and dropped.

Everything here assumes one segment = one span of one clip carrying both streams: `Segment` has no track or offset, `encodeSegment` maps `0:v:0` and `0:a:0` out of the same input with the same `-ss/-t`, and preview is a single `<video>`. Supporting it would need two independent segment lists, rendering video and audio as whole tracks and muxing them (which disturbs the frame-grid snapping that makes the joins seamless), a second `<audio>` element kept in sync with the video during preview, and a two-lane timeline. Several days of work, and it puts the parts that already work well at risk.

The cheaper route stays: press **xml** and finish in DaVinci Resolve, which has proper A/V tracks. This tool does the heavy, tedious pass - hundreds of silence cuts, speed ramps, volume - and hands over a timeline.

## Next
- Candidates: a delete/archive action for exported projects; refetch the project on tab focus (see note below); two `<video>` elements for gap-free clip switching; an `export.encoder: auto` toggle in the UI.

## Known issues / notes
- Browser audio at high playback rates: Chrome plays audio up to 16x, Firefox mutes above 5x, so 8x preview may be silent in Firefox. Export is unaffected.
- The playback engine checks cut boundaries once per animation frame, so up to ~16 ms of a cut can be heard in preview. Export is frame-accurate.
- **A volume boost cannot be previewed.** `<video>.volume` is clamped to 0..1, so a +6 dB range sounds unchanged while editing; the exported file is genuinely louder. Attenuation and mute preview correctly. A Web Audio `GainNode` around the element would lift the cap if this ever gets annoying.
- **A whole-clip volume draws nothing on the timeline** - only gain ranges get a green block. The clip chip turns green (or red with a bold **MUTED**) to compensate, so check the chip if a clip sounds wrong.
- **EDL cannot carry volume.** The `.fcpxml` has `<adjust-volume>` per segment, but the CMX3600 `.edl` silently drops every gain and mute. Use the fcpxml when volume matters.
- The audio export has no progress reporting or cancel button: it is fast enough (no video encoding) that it just blocks the button until it finishes.
- Server restart while a clip is processing: the clip is reset to `pending` and re-queued by the initial watcher scan.
- Analysis JSON for a 1 h clip is ~1.5 MB (plain JSON arrays); fine locally.
- Multi-clip preview switches the `<video>` src at clip boundaries, so expect a brief pause there; the export joins seamlessly.
- Mixed frame rates in one folder: the output uses the highest fps, so lower-fps clips get duplicated frames (normal). Set `export.fps` in `config.json` to force a value.
- Export re-encodes everything with libx264 `medium` crf 18: expect roughly 1-2x realtime for 1080p on this machine. Set `export.encoder` to `auto` in `config.json` to use h264_amf (much faster, slightly larger files).
- Export uses a snapshot of the edits taken when it starts; edits made while it runs are saved but only affect the next export.
- Exported projects stay in the queue (badge *exported*) and can be re-exported; there is no UI to delete them yet.
- A browser tab left open from before a code change keeps running the old bundle, so a new header/button may not appear and an export can finish without the page showing any status. Reload (Ctrl+F5) after changing client code. Worth revisiting: the editor could also refetch the project on focus, so a tab that missed SSE events catches up.
