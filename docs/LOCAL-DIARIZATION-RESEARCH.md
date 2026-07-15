# Local Meeting Transcription + Speaker Diarization — Research & Decision Record

**Date:** 2026-07-15
**Author:** Gerald Onyango (with Claude Code research agents)
**Goal:** Replace Krisp.ai for meeting transcription with a **fully local** tool that supports **real N-speaker diarization** (speaker labels), with post-call (not necessarily live) labeling being acceptable.

---

## TL;DR / Decision

- **Chosen tool: [OpenWhispr](https://github.com/OpenWhispr/openwhispr)** — an open-source (MIT), actively maintained Electron app positioned as a WisprFlow + Granola alternative. It **already ships real N-speaker diarization**, separate mic/system audio capture with echo cancellation, persistent editable speaker profiles, and local whisper.cpp transcription.
- **Diarization engine upgrade: [FluidAudio](https://github.com/FluidInference/FluidAudio)** added as an optional macOS-only offline backend. Newer models (pyannote community-1 class) running on the Apple Neural Engine — a modest accuracy gain and much lower power/latency than the default sherpa-onnx (CPU) path.
- **Rejected: [meetily](https://github.com/Zackriya-Solutions/meetily)** — diarization is deliberately a *paid PRO* feature and absent from the OSS app; adding it would mean building a whole subsystem as a permanently-diverging fork that upstream will never merge.
- **Live labels not required** → the only architectural advantage of one engine over another (real-time streaming) is moot. Choice comes down to accuracy + platform coverage. Post-call diarization of a 1-hour meeting takes **~15–30s with FluidAudio (ANE)** or **~2–5min with sherpa-onnx (CPU)**.

---

## The three candidates

### 1. meetily (Zackriya Solutions) — REJECTED
Tauri (Rust) + Next.js desktop app. MIT.

| Finding | Evidence |
|---|---|
| Transcription = whisper.cpp HTTP server (custom fork), GGML models, port 8178 | `backend/whisper-custom/server/server.cpp`, `build_whisper.sh:212` |
| Audio: mic + system captured **separately**, then **summed to mono** before Whisper (info discarded) | `frontend/src-tauri/src/audio/recording_manager.rs:124`, `pipeline.rs:154-180` |
| whisper.cpp fork **already has channel-energy diarization** — but only on a 2-channel stereo WAV upload; live `/stream` path is mono-only | `server.cpp:253-283` (`estimate_diarization_speaker`) |
| Transcript model has per-segment timing (`audio_start_time`/`audio_end_time`) but **no speaker field**; transcript view is read-only | `frontend/src/types/index.ts:7`; `backend/app/db.py:70-82` |
| **N-speaker diarization is explicitly a paid "Meetily PRO" roadmap item**, not in OSS | `README.md:47,231` |
| No ML libs in the Python backend (no torch/pyannote); Python backend is legacy/archived | `backend/requirements.txt`; `API_DOCUMENTATION.md` |

**Why rejected:** To get real N-speaker diarization you'd build the entire subsystem (embedding model, clustering, speaker data model, UI) from scratch, into the latency-sensitive Rust pipeline. That's a large, invasive diff that upstream will never take (it competes with their paid tier), so you'd carry a permanently-diverging fork forever. There was a cheap "me vs. them" 2-channel trick available, but that is *not* N-speaker.

### 2. OpenWhispr — CHOSEN
Electron 41 + React 19 + better-sqlite3 + onnxruntime-node. MIT. Very active (v1.7.5, commits through 2026-07-14, PRs to #1182). Used in production alongside apps like VoiceInk/Spokenly.

| Finding | Evidence |
|---|---|
| **Full N-speaker diarization already shipped** — offline `sherpa-onnx-diarize` (pyannote segmentation-3.0 + 3D-Speaker CAM++ embeddings + Silero VAD) | `src/helpers/diarization.js:50-77` |
| Plus **live speaker identification** on the system channel (VAD + CAM++ embeddings, ~1s intervals) | `src/helpers/liveSpeakerIdentifier.js`, `speakerEmbeddings.js` |
| Diarization runtime = ONNX (`onnxruntime-node`) + sherpa sidecar binary — **no Python, no torch** | `src/workers/onnxWorker.js`, download scripts |
| Mic + system captured as **separate streams end-to-end**, with **WebRTC AEC3** echo cancellation so participants don't bleed into your mic | `native/meeting-aec-helper/src/main.cc:108-157`, `meetingRecordingStore.ts:1074,1125` |
| Persistent, editable/lockable speaker profiles (`speaker_profiles` with embeddings + email, `speaker_mappings`); mic = "you", system channel gets diarized labels | `src/helpers/database.js:449-473`, `transcriptSpeakerState.ts` |
| STT = whisper.cpp (`whisper-cli` + server) **and** Parakeet-v3 via sherpa-onnx; plus cloud adapters (Deepgram, AssemblyAI, OpenAI, etc.) | `src/helpers/whisper.js`, `parakeet.js:122` |
| Segment shape: `{ id, text, source:"mic"|"system", timestamp?, speaker?, speakerName?, speakerStatus?, speakerLocked?, ... }` | `meetingRecordingStore.ts:26-39` |

**Why chosen:** It already *is* the thing we'd otherwise be building into meetily, done with the technically-strongest local approach, and it's cross-platform. In the common case you don't fork at all.

### 3. FluidAudio (FluidInference) — ADOPTED as diarization engine
Swift 6 / CoreML SDK for Apple devices (macOS 14+, iOS 17+). Apache-2.0/MIT models. Runs on the Apple Neural Engine (ANE).

| Finding | Evidence |
|---|---|
| Ships a **CLI** (`fluidaudiocli`) drivable as a headless sidecar — no Swift bindings needed for batch use | `Package.swift:17-20`; `Sources/FluidAudioCLI/FluidAudioCLI.swift` |
| `process <audio> --mode offline --num-speakers N --output results.json` → JSON with `segments[{ speakerId, startTimeSeconds, endTimeSeconds }]` | `Commands/ProcessCommand.swift:468-533`; `Diarizer/Core/DiarizerTypes.swift:191-196` |
| Offline pipeline = **pyannote community-1 class** models + WeSpeaker v2 embeddings (newer than sherpa's seg-3.0 + CAM++) | `Documentation/Models.md:50`; `ModelNames.swift:291-292` |
| Models auto-download from HuggingFace (~100 MB) on first run; offline/air-gapped load supported | `DiarizerModels.swift:92`; `README.md:245-255` |
| Diarizer expects **16 kHz mono Float32**; CLI auto-resamples arbitrary input files | `DiarizerManager.swift:89`; `ProcessCommand.swift:77` |
| Benchmark: **17.7% DER, 141× real-time on M1** (AMI ES2004a) | `Documentation/Guides/GettingStarted.md:658-664` |
| **macOS-only** CLI (`#error` off macOS); true streaming diarization is a Swift *library* API, **not** exposed via the CLI | `FluidAudioCLI.swift:223`; `Diarizer/Sortformer/`, `LS-EEND/` |

**Why adopted (as optional Mac backend, not default):** Better models + ANE speed/power for the offline pass, and it drops into OpenWhispr's existing sidecar contract almost 1:1. But because it's macOS-only and the CLI can't stream, it augments rather than replaces the cross-platform sherpa default.

---

## Diarization landscape (2025–2026) — why sherpa-onnx / FluidAudio are the right shape

Independent research on local N-speaker diarization for a whisper.cpp desktop app:

| Option | Quality | Runtime | Streaming | Bundling |
|---|---|---|---|---|
| **pyannote.audio 4.0 / community-1** | Best OSS (AMI-IHM ~17% DER) | PyTorch (MPS) | Offline | Python sidecar (~1-3 GB) |
| **sherpa-onnx** (= pyannote seg-3.0 in ONNX + CAM++) | ~pyannote 3.0 class | ONNX/C++, no Python | Offline | **Node addon + Rust bindings — bundles natively** |
| **FluidAudio** (CoreML) | pyannote community-1 class + Sortformer/LS-EEND | Swift/CoreML on ANE, no Python | Yes (library only) | macOS-only |
| **diart** | pyannote quality | PyTorch | **True streaming** | Python sidecar |
| **NeMo Streaming Sortformer** | SOTA streaming, max 4 spk | PyTorch, ONNX export broken | True streaming | Impractical to bundle |
| **whisperX** | pyannote 3.1 + word align | PyTorch | Offline | Python sidecar; redundant w/ whisper.cpp |
| **senko** | 3D-Speaker optimized (~8s/hr on M3) | PyTorch/CoreML, still Python | Offline | Python sidecar |

**Key takeaways:**
- Only **sherpa-onnx** gives a full cross-platform no-Python story (Electron Node addon `sherpa-onnx-node`, Tauri via `sherpa-rs`). Everything torch-based means shipping a ~1-3 GB Python sidecar.
- **FluidAudio** is the no-Python option *on macOS only*, and uniquely runs on the ANE.
- True **streaming** diarization (diart, NeMo Sortformer, FluidAudio library) all have real tradeoffs; the no-Python streaming options are macOS-only. Since **live labels aren't required here**, this whole axis is moot.
- Accuracy: ONNX/sherpa path is a few DER points behind pyannote community-1, with the gap widening on overlapped/noisy speech. FluidAudio closes most of that gap on macOS.

**Sources:** [sherpa-onnx diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html) · [sherpa-rs](https://github.com/thewh1teagle/sherpa-rs) · [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) · [NVIDIA Streaming Sortformer](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/) · [senko](https://github.com/narcotic-sh/senko) · [FluidAudio](https://github.com/FluidInference/FluidAudio)

---

## Processing-time expectations (post-call, macOS Apple Silicon)

Only the **diarization pass** is added after the call — OpenWhispr transcribes live, and aligning speakers to the transcript (`mergeWithTranscript`) is instant.

| Meeting length | FluidAudio (ANE) | sherpa-onnx (CPU) |
|---|---|---|
| 15 min | ~5 s | ~20–60 s |
| 30 min | ~10 s | ~1–2 min |
| 60 min | ~15–30 s | ~2–5 min |
| 90 min | ~30–45 s | ~4–8 min |

FluidAudio figures derive from its published 141× real-time benchmark; sherpa figures are estimates (CPU/ONNX, not ANE). More speakers / heavy overlap increases clustering cost. Both are background tasks you won't notice.

---

## OpenWhispr diarization integration contract (for the FluidAudio swap)

The offline diarizer is a swappable sidecar with a tiny contract:

- **Input:** path to a 16 kHz mono 16-bit WAV (callers convert via ffmpeg).
- **Output:** `Array<{ start: number, end: number, speaker: string }>` in seconds; `[]` on any failure. Speaker strings are opaque (renumbered to `speaker_0..n` downstream).
- **Options:** `{ numSpeakers: int (-1 = auto), threshold: 0-1 }`.
- **Engine-specific code lives in 3 functions** in `src/helpers/diarization.js`: `getBinaryPath()`, the `args` array in `diarize()`, and `_parseOutput()`.
- **Untouched by an engine swap:** IPC handlers (`ipcHandlers.js:2369` `diarize-audio-file`, `:9075` meeting path), `mergeWithTranscript` → `applyConfirmedSpeaker`, and the entire **live** identifier (`liveSpeakerIdentifier.js`, in-process ONNX — never calls the sidecar).

See `FLUIDAUDIO-INTEGRATION.md` for exactly what was changed.

---

## Environment (setup machine)

- macOS 26.2 (Apple Silicon), Swift 6.2.4 (CommandLineTools), Node 25.6, npm 11.8, ffmpeg 8.0.
- OpenWhispr cloned to `~/Documents/dev/openwhispr` (full history, for upstream pulls).
- FluidAudio cloned to `~/Documents/dev/FluidAudio`; CLI built via `swift build -c release --product fluidaudiocli`.
