# OpenWhispr Fork — Handoff

_Last updated: 2026-07-16. Pick-up doc for continuing work on the futuregerald/openwhispr fork._

## Current state

- **Branch/commit:** `main` @ `41bc813e` (PR #5 merged). Version **1.8.0**.
- **PRs #1–#5 all merged.** No open PRs. Full history + rationale in [`DECISIONS-LOG.md`](DECISIONS-LOG.md).
- The fork is a **fully local, private meeting transcriber**: on-device Parakeet transcription by default, FluidAudio (ANE) / sherpa-onnx N-speaker diarization, local-only onboarding (no signup), telemetry off, cloud/account UI removed, and an opt-in auto-start-recording feature.

## Repo / environment

- Local clone: `~/Documents/dev/openwhispr`. Remotes: `origin` = fork (push here), `upstream` = OpenWhispr/openwhispr (pull updates only).
- FluidAudio source (for rebuilding its CLI): `~/Documents/dev/FluidAudio` (pinned v0.15.5).
- Toolchain: macOS 26, Apple Silicon, Swift 6.2 (CommandLineTools), Node ≥24, ffmpeg. No full Xcode.

## Run / build

```bash
npm install
npm run setup:fluidaudio   # optional (macOS): build the FluidAudio ANE diarization engine
npm run dev                # dev run (predev compiles native helpers + downloads binaries)
npm run build:mac:arm64    # production .dmg + .zip in dist/ (unsigned; recipients: xattr -dr com.apple.quarantine)
```
- Typecheck: `cd src && npx tsc --noEmit`. Renderer build: `npm run build:renderer`.
- **Workflow policy:** open PRs and **leave them open for review** — do not auto-merge unless told.

## Where things live (key files)

- **Diarization engine dispatch:** `src/helpers/diarization.js` (`getDiarizationEngine`, `_diarizeFluidAudio`, `_diarizeSherpa`). FluidAudio setup: `scripts/setup-fluidaudio.js`.
- **Transcription defaults / all settings:** `src/stores/settingsStore.ts`. Settings UI: `src/components/SettingsPage.tsx`, `src/components/settings/{MeetingSettings,UploadSettings}.tsx`, picker `src/components/TranscriptionModelPicker.tsx`.
- **Onboarding:** `src/components/OnboardingFlow.tsx`. Auth (neutered): `src/lib/auth.ts`.
- **Meeting detection + auto-start:** `src/helpers/meetingDetectionEngine.js`, `callStateDetector.js`, `browserMeetingUrlChecker.js`, native `resources/macos-call-detector.swift` (built by `scripts/build-macos-call-detector.js`). Speaker profiles: `src/helpers/{liveSpeakerIdentifier,speakerEmbeddings}.js`, `database.js`.
- **Build config:** `package.json` (`compile:native`, `prebuild:mac`), `electron-builder.json` (bundle filters, `identity:null`/`notarize:false`).

## Immediate next steps (pick up here)

1. **TEST auto-start on a real call** (PR #5, unverified). `npm run dev` → Settings → General → enable "Auto-start recording in meetings" → join a real Google Meet (approve the one-time macOS Automation prompt) → confirm a note is created + recording starts ~seconds after joining, and stops when you leave. Sanity: leave a Meet *landing page* open with no call → must NOT start. If it misbehaves, likely spots: `callStateDetector` debounce timing, the URL regexes in `browserMeetingUrlChecker.js`, or CoreMediaIO camera-in-use behavior on this macOS version.
2. **Version bump → 1.9.0** for the auto-start feature (add CHANGELOG entry). Not yet done.
3. **Decide on MCP card removal** — `src/components/McpIntegrationCard.tsx` in `IntegrationsView.tsx`. It's a dead hosted-cloud feature (empty API URL). Offered but never confirmed; remove if wanted.

## Backlog / known gaps

- Diarization **accuracy** not validated on real multi-party audio (synthetic TTS is a poor proxy).
- Full **`.dmg` build** not run end-to-end (should bundle FluidAudio via `prebuild:mac`).
- Call-detector has **no per-app attribution** (CoreMediaIO limitation) — URL filter compensates; log-stream parsing could add it.
- **Google Calendar** won't work in the fork without your own `GOOGLE_CALENDAR_CLIENT_ID`/`SECRET` in `.env` (+ optional local OAuth callback to avoid the openwhispr.com redirect).
- Possible future: browser-based Zoom/Teams already covered by URL patterns; native app attribution; a *local* MCP server over the SQLite notes DB (the shipped one is remote/hosted).

## Gotchas

- **Existing installs keep persisted localStorage** — default changes (local-only, Parakeet, auto-start) apply to fresh installs; existing profiles keep prior settings. Reset dev profile: `rm -rf ~/Library/"Application Support"/OpenWhispr-development`.
- `resources/bin/` is gitignored — native binaries/models are built/downloaded, not committed.
- FluidAudio auto-selects only if its binary is present (`npm run setup:fluidaudio`); else sherpa-onnx.
