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
- `_diarizeFluidAudio()` — spawns `fluidaudiocli process <wav> --mode streaming --output <tmp.json> [--num-clusters N]`, parses the JSON, returns the standard `{ start, end, speaker }[]` contract. Full parity with sherpa's process tracking, pid file, 60-min timeout, temp-file cleanup on every exit path, and always-resolve-never-throw behavior.
- `_parseFluidAudioOutput()` — maps FluidAudio's `segments[].{speakerId,startTimeSeconds,endTimeSeconds}` to the contract; drops null-speaker / NaN / inverted segments.

### `src/helpers/ipcHandlers.js`
- `diarize-audio-file` handler: the availability guard changed from sherpa-specific `isModelDownloaded()` to engine-agnostic `isAvailable()`, so file-upload diarization works on FluidAudio-only setups too.

**Not touched:** the transcript merge (`mergeWithTranscript` → `applyConfirmedSpeaker`), the meeting pipeline, and the live speaker identifier (`liveSpeakerIdentifier.js`, in-process ONNX — never calls the sidecar). The engine swap is invisible to all of them because they depend only on the `{ start, end, speaker }[]` contract.

## The contract (why the swap is safe)

Any diarization engine must satisfy:
- **Input:** path to a 16 kHz mono WAV.
- **Output:** `Array<{ start:number, end:number, speaker:string }>` in seconds, or `[]` on any failure (never throws/rejects).
- **Options:** `{ numSpeakers:int (-1=auto), threshold:number }`.

Note: OpenWhispr's `threshold` (sherpa scale, default 0.55) is **not** forwarded to FluidAudio,
whose clustering threshold is a different scale (default ~0.70). FluidAudio uses its own tuned
default to avoid over-splitting speakers. `numSpeakers` maps to `--num-clusters` (streaming mode).

## Configuration (env vars)

| Variable | Values | Effect |
|---|---|---|
| `OPENWHISPR_DIARIZATION_ENGINE` | `fluidaudio` \| `sherpa` | Force a backend. Unset = auto (FluidAudio on macOS when installed, else sherpa). |
| `OPENWHISPR_FLUIDAUDIO_MODE` | `streaming` (default) \| `offline` | FluidAudio pipeline. `streaming` = pyannote seg + WeSpeaker (benchmarked path). `offline` = VBx clustering. Both process the whole recording (this is a post-call pass, not live). |

## Install / rebuild / revert

```bash
npm run setup:fluidaudio          # build + install the CLI into resources/bin (skips if present)
npm run setup:fluidaudio -- --force   # rebuild
FLUIDAUDIO_REF=v0.16.0 npm run setup:fluidaudio   # pin a different FluidAudio version
```

- Pinned version: **FluidAudio v0.15.5** (`scripts/setup-fluidaudio.js`).
- Requires Xcode Command Line Tools (`xcode-select --install`) for Swift 6+. No full Xcode needed.
- **Revert to sherpa entirely:** delete `resources/bin/fluidaudio-diarize-*` (auto-select falls back to sherpa), or set `OPENWHISPR_DIARIZATION_ENGINE=sherpa`.

## Verification done

- FluidAudio CLI runs headless, auto-downloads CoreML models, emits the expected JSON; 142–164× real-time on a 27s clip (matches upstream's 141× benchmark).
- End-to-end via the real `DiarizationManager`: engine selection, binary resolution, `isAvailable()`, and `diarize()` all return the correct `{ start, end, speaker }[]` contract; non-integer `numSpeakers` coerced to auto; sherpa fallback still routes correctly.
- Diarization *accuracy* was not validated locally (synthetic `say` voices are a poor proxy — they share a TTS pipeline). Validate on a real multi-party recording; model accuracy is externally established (17.7% DER on AMI).

## Packaging note

For a distributable `.dmg`, run `npm run setup:fluidaudio` **before** `npm run build:mac` so the
binary is bundled into `resources/bin`. Distribution to other machines requires the whole app to
be signed/notarized (Apple Developer ID) or recipients must clear the quarantine attribute —
see `FORK-SETUP.md`.
