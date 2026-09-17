# FluidAudio Diarization Backend — Integration Notes

This fork adds **[FluidAudio](https://github.com/FluidInference/FluidAudio)** as an optional,
macOS-only speaker-diarization backend alongside OpenWhispr's default `sherpa-onnx` engine.
FluidAudio runs pyannote-community-1-class models on the **Apple Neural Engine** via CoreML —
higher accuracy and much lower power/latency than the CPU/ONNX sherpa path, for the post-call
diarization pass.

See `LOCAL-DIARIZATION-RESEARCH.md` for the full evaluation (meetily vs OpenWhispr vs FluidAudio).

## What changed

All logic changes live in **two files**; everything else is additive (a build script + docs).

### `src/helpers/diarization.js`
- `getFluidAudioBinaryPath()` — resolves `resources/bin/fluidaudio-diarize-<platform>-<arch>` (macOS only; caches hit **and** miss).
- `getDiarizationEngine()` — returns `"fluidaudio"` or `"sherpa"`. Explicit env override wins; otherwise FluidAudio is auto-selected on macOS when its binary is present, else sherpa. Warns on unrecognized env values.
- `isAvailable()` — now **engine-agnostic**: true if *either* backend can run, so availability gates never skip diarization because the non-active backend is the installed one.
- `diarize()` — thin dispatcher → `_diarizeFluidAudio()` (new) or `_diarizeSherpa()` (the original body, renamed byte-for-byte). Falls back to sherpa if FluidAudio is selected but its binary is missing.
- `_diarizeFluidAudio()` — spawns `fluidaudiocli process <wav> --mode offline --output <tmp.json> --threshold 0.5 [--min-speakers N --max-speakers N | --max-speakers N]` (arguments built by `buildFluidAudioArgs`), parses the JSON, returns the standard `{ start, end, speaker }[]` contract. Full parity with sherpa's process tracking, pid file, 60-min timeout, temp-file cleanup on every exit path, and always-resolve-never-throw behavior.
- `_parseFluidAudioOutput()` — maps FluidAudio's `segments[].{speakerId,startTimeSeconds,endTimeSeconds}` to the contract; drops null-speaker / NaN / inverted segments.

### `src/helpers/ipcHandlers.js`
- `diarize-audio-file` handler: the availability guard changed from sherpa-specific `isModelDownloaded()` to engine-agnostic `isAvailable()`, so file-upload diarization works on FluidAudio-only setups too.

**Not touched:** the transcript merge (`mergeWithTranscript` → `applyConfirmedSpeaker`), the meeting pipeline, and the live speaker identifier (`liveSpeakerIdentifier.js`, in-process ONNX — never calls the sidecar). The engine swap is invisible to all of them because they depend only on the `{ start, end, speaker }[]` contract.

## The contract (why the swap is safe)

Any diarization engine must satisfy:
- **Input:** path to a 16 kHz mono WAV.
- **Output:** `Array<{ start:number, end:number, speaker:string }>` in seconds, or `[]` on any failure (never throws/rejects).
- **Options:** `{ numSpeakers:int (-1=auto), threshold:number }`.

Note: OpenWhispr's `threshold` option (sherpa scale, default 0.55) is **not** forwarded to FluidAudio,
whose threshold uses a different scale. In **offline** mode the app passes its own
`--threshold 0.5` (`FLUIDAUDIO_OFFLINE_THRESHOLD`, measured against real meeting headcounts on
FluidAudio v0.15.7 — re-check with `scripts/diarization-headcount-eval.js` after any engine bump).
From v0.15.6 (FluidAudio PR #802) the offline threshold is a Euclidean distance applied directly,
so a **higher** threshold merges more speakers (fewer clusters) — the reverse of v0.15.5, where it
cut at `sqrt(2 − 2t)` and a higher value split more.
streaming mode passes no threshold. `numSpeakers` maps to `--min-speakers N --max-speakers N`
(offline) or `--num-clusters N` (streaming).

## Configuration (env vars)

| Variable | Values | Effect |
|---|---|---|
| `OPENWHISPR_DIARIZATION_ENGINE` | `fluidaudio` \| `sherpa` | Force a backend. Unset = auto (FluidAudio on macOS when installed, else sherpa). |
| `OPENWHISPR_FLUIDAUDIO_MODE` | `offline` (default) \| `streaming` | FluidAudio pipeline. `streaming` = pyannote seg + WeSpeaker (benchmarked path). `offline` = VBx clustering. Both process the whole recording (this is a post-call pass, not live). |

## Install / rebuild / revert

```bash
npm run setup:fluidaudio                 # build + install the CLI into resources/bin (skips when already built from the pinned commit)
npm run setup:fluidaudio -- --force      # rebuild even if present
node scripts/setup-fluidaudio.js --check # warn (never build) if the installed engine is stale — used by dev/start
FLUIDAUDIO_REF=v0.16.0 npm run setup:fluidaudio   # build a different ref instead of the pin (see Override below)
```

- Pinned: **FluidAudio tag `v0.15.7`, commit `41540ea237350afe5117a082b5c28eda642d0612`**
  (`FLUIDAUDIO_TAG` / `FLUIDAUDIO_COMMIT` in `scripts/setup-fluidaudio.js`). The commit is pinned, not
  just the tag, because a tag can be moved upstream; after checkout the script verifies `git rev-parse
  HEAD` against `FLUIDAUDIO_COMMIT` and aborts the build if they differ.
- Stamp file: `resources/bin/.fluidaudio-diarize.<platform>-<arch>.ref` (dotfile, matching the
  `.macos-globe-listener.<arch>.hash` marker convention in `scripts/build-globe-listener.js`) holds the
  commit sha the installed binary was actually built from. `npm run setup:fluidaudio` rebuilds
  automatically whenever this stamp is missing or differs from the pinned commit — no `--force` needed
  after bumping the pin. It skips only when the binary exists and the stamp matches.
- **`--check`** (used by `prestart`/`predev`/`predev:main`) never clones or builds; it only warns — naming
  the installed commit (or "no stamp") and the pinned tag/commit — when the installed engine is stale, so
  a `dev`/`start` run does not silently run an old engine at the new threshold.
- **`pack`/`dist`** (`prepack`/`predist`) now run `setup:fluidaudio` before `verify:binaries`, same as
  `prebuild`/`prebuild:mac`, so a packaged or dist build always ships the pinned engine.
- **`npm run verify:binaries`** aborts the build (exit 1) if a FluidAudio binary is present in
  `resources/bin` but its stamp is missing or does not match the pinned commit — a stale engine can no
  longer be packaged or distributed silently.
- **Override** (`FLUIDAUDIO_REF=<git tag or commit sha, not a branch>`): always rebuilds (the pin's stamp-matching skip does
  not apply to an override) and is **not** accepted by `verify:binaries`, which only ever accepts the
  pinned commit — an override build is for local experimentation, not for shipping.
- Requires Xcode Command Line Tools (`xcode-select --install`) for Swift 6+. No full Xcode needed.
- **Revert to sherpa entirely:** delete `resources/bin/fluidaudio-diarize-*` (auto-select falls back to sherpa), or set `OPENWHISPR_DIARIZATION_ENGINE=sherpa`.

## Verification done

- FluidAudio CLI runs headless, auto-downloads CoreML models, emits the expected JSON; 142–164× real-time on a 27s clip (matches upstream's 141× benchmark).
- End-to-end via the real `DiarizationManager`: engine selection, binary resolution, `isAvailable()`, and `diarize()` all return the correct `{ start, end, speaker }[]` contract; non-integer `numSpeakers` coerced to auto; sherpa fallback still routes correctly.
- Diarization *accuracy* was not validated locally (synthetic `say` voices are a poor proxy — they share a TTS pipeline). Validate on a real multi-party recording; model accuracy is externally established (17.7% DER on AMI).

## Packaging note

`npm run build:mac` (and `pack` / `dist`) runs `setup:fluidaudio` before packaging, so the pinned
binary is built into `resources/bin` and bundled automatically. Distribution to other machines
requires the whole app to be signed/notarized (Apple Developer ID) or recipients must clear the
quarantine attribute — see `FORK-SETUP.md`.

## Known limitations

- **Intel Macs (x64) — won't fix.** FluidAudio is built for the architecture of the machine running
  the build, and the x64 macOS release leg runs on an Apple Silicon runner. The Intel build therefore
  carries an arm64 `fluidaudio-diarize` binary it cannot run, and diarization on Intel Macs uses
  sherpa-onnx instead. No one using this fork is on an Intel Mac, so this is not being fixed.
