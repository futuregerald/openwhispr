<p align="center">
  <img src="src/assets/logo.svg" alt="OpenWhispr" width="120" />
</p>

<h1 align="center">OpenWhispr</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" />
  <img src="https://img.shields.io/badge/version-1.22.3-informational?style=flat" alt="Version 1.22.3" />
  <img src="https://img.shields.io/badge/build-from%20source-orange?style=flat" alt="Build from source" />
  <img src="https://img.shields.io/badge/telemetry-none-brightgreen?style=flat" alt="No telemetry" />
</p>

<p align="center">
  Private, on-device voice-to-text dictation and meeting notes — with real speaker diarization.<br/>
  macOS, Windows, and Linux. Nothing leaves your machine unless you ask it to.
</p>

---

<h2 align="center">⚠️ THIS IS A FORK — AND IT HAS CHANGED A LOT</h2>

<p align="center">
  <strong>
    Forked from <a href="https://github.com/OpenWhispr/openwhispr">OpenWhispr/openwhispr</a> ·
    274 commits ahead · 338 files changed · ~39,000 lines added
  </strong>
</p>

<p align="center">
  This is <strong>not</strong> a mirror and it is <strong>not</strong> drop-in compatible with upstream's
  documentation.<br/>
  Accounts, billing, hosted cloud transcription, and every phone-home call have been removed.<br/>
  If you want the original, go <a href="https://github.com/OpenWhispr/openwhispr">upstream</a>.
</p>

---

## What's different in this fork

Grouped by what it actually changes for you. Everything below is in `main`.

### It is genuinely local now

- **No phone-home, no telemetry.** The Better Auth session ping to `auth.openwhispr.com`, the
  automatic startup update check, and a Google Fonts fetch are all gone. There is no analytics
  SDK. Nothing leaves your device unless you opt into a cloud provider yourself.
- **No account, no signup, no billing.** The Account, Plans & Billing, Workspace and Pro-upsell
  sections were removed outright. First run goes straight to on-device transcription.
- **Hosted cloud transcription removed.** Speech-to-text offers **Local** and **Self-hosted**
  only. Bring-your-own-key cloud providers are still available for the *AI* features, strictly
  opt-in.
- **Cloud note sync removed**, including the database columns that backed it.

### Real speaker diarization, on-device

This is why the fork exists.

- **[FluidAudio](https://github.com/FluidInference/FluidAudio) as an optional macOS backend** —
  Swift/CoreML running pyannote-community-1 models on the **Apple Neural Engine**. More accurate
  and far lower power than the default sherpa-onnx CPU engine. Auto-selected on macOS when
  installed; **falls back to sherpa-onnx automatically** everywhere else.
- **A speaker panel that works** — rename, bulk-merge, and filter speakers; locked names are no
  longer overwritten by a later pass.
- **Hear a speaker before you name them** — play a few seconds of any speaker, starting from
  where they actually talk for a while rather than from a half-word.
- **Voice fingerprints across meetings**, so the same person keeps their name next time.

### Meeting recordings that survive

- **Audio is kept** (mic and system, Opus-encoded) so a meeting can be re-processed later.
- **Re-transcribe at high quality** on demand, with a diff summary of what changed.
- **Long calls are processed in passes** instead of being refused.
- **Welded notes are detected and split** — when two meetings ran into one recording, segments
  are assigned rather than lost, and the app reports which belong to neither.
- **Reprocess old recordings** in bulk.

### A post-call pipeline you can see and retry

- Four steps after every call — re-transcribe, title, classify, write notes — with a live
  indicator showing elapsed time and sub-stages.
- **Retry the step that actually failed**, not the whole pipeline.
- **A persisted background job queue**, so quitting mid-process no longer loses the work.
- Meeting-detection health is recorded and surfaced in the UI instead of failing silently.

### Meeting types

- **Seven built-in types** (Standup, 1:1, Team Sync, Project Sync, Sprint Planning, Architecture
  Review, Customer Call), each with its own note template — plus a custom type editor.
- **Auto-detected from the transcript**, or auto-mapped from the calendar event's title.
- Regenerate a meeting's notes as a different type at any time.

### Local-first defaults

- **NVIDIA Parakeet TDT 0.6B v3** is the default transcription engine — fast, 680 MB,
  multilingual — and auto-downloads on first run with a progress banner. Whisper is one click
  away in Settings for noisy audio or other languages.
- **LLM inference defaults to local**, with a guided Gemma download when nothing is configured.
- Provider settings simplified to **local** and **remote** rather than a wall of options.

### Other additions

- **Agent web search** on a bring-your-own Brave API key.
- New colour scheme (Silver / Pacific Cyan / Blue Slate).
- **78 new test files** added under `test/helpers/` (125 in total) — the fork carries
  substantially more test coverage than it inherited.

### Known limitations

- **No published binaries.** Build from source (below). Builds are unsigned and un-notarized.
- **Intel macOS is not supported** — the bundled FluidAudio binary is arm64-only.
- **Upstream's docs at [docs.openwhispr.com](https://docs.openwhispr.com) still describe accounts
  and hosted cloud features that this fork removed.** Treat them as a general guide, not as the
  reference for this build.

---

## What it does

Press a hotkey, speak, and your words appear at your cursor in whatever app you're using. Join a
meeting and it records, transcribes, labels who said what, and writes you notes — all on your
machine.

## Features

- **Voice dictation** — a global hotkey to dictate into any app, with automatic pasting
- **AI agent** — talk to Claude, GPT, Gemini, Groq, Tinfoil, OpenRouter, or a local model, with a
  named voice assistant and optional web search
- **Voice agent hotkey** — a dedicated hotkey that sends dictation straight to your agent as a
  command: no wake word, no cleanup pass
- **Meeting transcription** — auto-detects Zoom, Teams, Webex and FaceTime calls, with system
  audio capture and Google Calendar integration
- **Speaker diarization** — on-device speaker labelling with voice fingerprints that persist
  across meetings
- **Notes** — folders, full-text and semantic search, AI actions, markdown mirroring to disk
- **Custom dictionary** — teach it names, jargon and brand terms it keeps getting wrong
- **Public API & MCP** — manage notes and transcriptions programmatically, or connect your own AI
  assistant

## Install

There are **no published releases for this fork**. Build it from source:

```bash
git clone https://github.com/futuregerald/openwhispr.git
cd openwhispr
npm install
npm run setup:fluidaudio   # optional, macOS only: the ANE diarization engine
npm run dev
```

**Requirements**

| | |
|---|---|
| Node.js | 24+ (pinned in `.nvmrc`) |
| npm | **11.11.0+** — see below |
| macOS extras | Xcode Command Line Tools (`xcode-select --install`), only for `setup:fluidaudio` |

> **The npm floor is not optional.** Below 11.11.0, npm silently strips the `libc` fields from
> `package-lock.json`, which is what picks the right Linux native binary — and the stripped
> lockfile still installs, so nothing catches it. `engine-strict` turns that into a hard error.
> Fix with `npm i -g npm@11`. On Node 25.x use `npm@11`, **not** `npm@latest` — npm 12 doesn't
> support the 25.x line.

First run starts a **local-only** onboarding with no account step, and downloads the default
Parakeet model (~680 MB).

## Build a shareable app (macOS)

```bash
npm run build:mac:arm64   # Apple Silicon
```

`prebuild:mac` runs first automatically: it compiles the native Swift helpers, downloads the
whisper / sherpa-onnx / qdrant binaries, and bundles the FluidAudio engine — so the installed app
needs no `setup:fluidaudio`. Output lands in `dist/`.

These builds are **unsigned and un-notarized** (this fork ships no Apple Developer ID), so
Gatekeeper blocks the app on first launch. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```

Or right-click the app → **Open**, or **System Settings → Privacy & Security → Open Anyway**.

To re-enable real signing and notarization with your own Developer ID, see
[docs/FORK-SETUP.md](docs/FORK-SETUP.md).

## Documentation

Fork-specific:

- [Fork setup, sharing & upstream-sync guide](docs/FORK-SETUP.md)
- [FluidAudio integration notes](docs/FLUIDAUDIO-INTEGRATION.md)
- [Local diarization research & decision record](docs/LOCAL-DIARIZATION-RESEARCH.md)
- [Decisions log](docs/DECISIONS-LOG.md)
- [Network allowlist](docs/network-allowlist.md)
- [`CLAUDE.md`](CLAUDE.md) — the full technical reference for the codebase

Upstream's [docs.openwhispr.com](https://docs.openwhispr.com) covers general usage and platform
setup, but **describes accounts and cloud features this fork removed**.

## Tech stack

React 19 · TypeScript · Tailwind CSS v4 · Electron 41 · better-sqlite3 · whisper.cpp ·
sherpa-onnx · FluidAudio (CoreML) · Qdrant · llama.cpp · shadcn/ui

## Contributing

Issues and pull requests are welcome on
[this repository](https://github.com/futuregerald/openwhispr). If your change isn't
fork-specific, consider sending it [upstream](https://github.com/OpenWhispr/openwhispr) as well —
this fork keeps its changes isolated so upstream updates still merge cleanly.

## License

[MIT](LICENSE) — free for personal and commercial use, same as upstream.

## Acknowledgments

Built on top of [**OpenWhispr**](https://github.com/OpenWhispr/openwhispr) by the OpenWhispr
team. This fork would not exist without their work.

- **[FluidAudio](https://github.com/FluidInference/FluidAudio)** — CoreML speaker diarization on the Apple Neural Engine
- **[pyannote](https://github.com/pyannote/pyannote-audio)** — the speaker diarization models behind it
- **[OpenAI Whisper](https://github.com/openai/whisper)** — speech recognition
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — high-performance local inference
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** — fast multilingual ASR
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — cross-platform ONNX runtime
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — local LLM inference
- **[Qdrant](https://github.com/qdrant/qdrant)** — local vector search
- **[Hugging Face](https://huggingface.co/)** — model hosting
- **[Electron](https://www.electronjs.org/)**, **[React](https://react.dev/)**, **[shadcn/ui](https://ui.shadcn.com/)** — the app shell
