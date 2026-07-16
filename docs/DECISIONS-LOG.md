# OpenWhispr Fork — Decisions & Actions Log

**Fork:** [futuregerald/openwhispr](https://github.com/futuregerald/openwhispr) (of [OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr))
**Purpose:** A fully local, private meeting transcriber to replace Krisp.ai — real N-speaker diarization, on-device by default, nothing sent off-device unless explicitly opted in.
**Working period:** 2026-07-15 → 2026-07-16
**Companion docs:** [`LOCAL-DIARIZATION-RESEARCH.md`](LOCAL-DIARIZATION-RESEARCH.md) · [`FLUIDAUDIO-INTEGRATION.md`](FLUIDAUDIO-INTEGRATION.md) · [`FORK-SETUP.md`](FORK-SETUP.md) · plan docs in [`plans/`](plans/)

---

## The core decision: OpenWhispr, not meetily

Evaluated three options for a local Krisp replacement with real N-speaker diarization (full research in `LOCAL-DIARIZATION-RESEARCH.md`):

- **meetily** — REJECTED. Diarization is a paid "PRO" feature, absent from OSS; adding it = building a whole subsystem as a permanently-diverging fork upstream would never take.
- **OpenWhispr** — CHOSEN. Already ships local whisper.cpp + sherpa-onnx N-speaker diarization + persistent editable speaker profiles, MIT, actively maintained.
- **FluidAudio** — ADOPTED as an optional diarization *engine* (see PR #1).

**Diarization landscape finding:** sherpa-onnx (pyannote seg-3.0 ONNX + CAM++, no PyTorch) is the best bundle-friendly cross-platform engine; FluidAudio (CoreML on the Apple Neural Engine, pyannote-community-1-class) is the strongest *macOS* option. Live/streaming diarization is hard locally; **post-call diarization was confirmed acceptable**, which removed the main reason to prefer one engine's architecture over another.

## Remotes / workflow conventions

- `origin` = the fork (futuregerald/openwhispr) — all work pushes here.
- `upstream` = OpenWhispr/openwhispr — for pulling their updates only. Nothing pushes here.
- **Workflow correction mid-session:** early PRs were auto-merged; the user then asked to **leave PRs open for review**. Policy from PR #5 onward: open PRs, do **not** merge until the user says so.

---

## What shipped (PRs #1–#5, all merged to `main`)

### PR #1 — FluidAudio diarization + local-only foundation + shareable builds
- Added **FluidAudio (ANE) diarization backend** as an optional macOS engine, auto-selected when present, **sherpa-onnx fallback** otherwise. Isolated to `src/helpers/diarization.js` (engine dispatcher; original sherpa path preserved as `_diarizeSherpa`) + one `ipcHandlers.js` guard, plus additive `scripts/setup-fluidaudio.js`. Bundled into builds. Details in `FLUIDAUDIO-INTEGRATION.md`.
- **Local-only onboarding:** removed the signup/account step (`skipAuth` default true).
- **Telemetry off by default:** `AUTH_URL` defaults empty (no auth.openwhispr.com session ping), startup auto-update check disabled, Google Fonts fetch removed. OpenWhispr has **no analytics SDK**.
- **Unsigned fork builds:** `identity:null`, `notarize:false`, publish owner → futuregerald.
- Decision reviewed by a Fable code-review agent: no critical issues.

### PR #2 — Default transcription = NVIDIA Parakeet TDT 0.6B v3
- Rationale: faster, smaller (680MB vs Whisper turbo 1.6GB), higher English/European accuracy on Apple Silicon, multilingual w/ auto-detect. Whisper (turbo) stays one click away in Settings for noisy audio / non-European languages.
- Change: `settingsStore.ts` `localTranscriptionProvider` → `nvidia`, `parakeetModel` → `parakeet-tdt-0.6b-v3`; registry marks it recommended.

### PR #3 — Local + self-hosted only STT; remove account/plans/billing/Pro
- **Speech-to-Text, note recording, audio upload:** only **Local** and **Self-hosted** (removed OpenWhispr-cloud + hosted BYOK providers OpenAI/Groq/xAI/Mistral/Corti/Tinfoil). Picker collapses to the self-hosted `custom` endpoint; defaults + legacy `openwhispr` mode map to `local`.
- Removed **Account, Plans & Billing, Workspace** settings nav sections and the **Pro upsell** banners. Section components left in place but unreachable (merge-clean).

### PR #4 — Version bump to 1.8.0
- Consolidated fork-release bump (1.7.5 → 1.8.0) with a `CHANGELOG.md` entry covering PRs #1–#3.

### PR #5 — Opt-in auto-start recording on real call detection
- **New "Auto-start recording in meetings" toggle** (Settings → General, default off). When on, recording auto-starts once you're *actually in a call* and auto-stops when it ends.
- Keys off **real in-call state, not an open tab**:
  - New native **`macos-call-detector`** helper (CoreMediaIO camera + CoreAudio mic `DeviceIsRunningSomewhere`) — fires even when muted; silent for an idle meeting landing page. Emits `{"device","active"}` JSON.
  - **`browserMeetingUrlChecker`** confirms an active meeting-code URL (Meet/Zoom-web/Teams-web) via AppleScript; degrades gracefully if Automation denied.
  - **`callStateDetector`** debounces (2.5s on / 8s off) → `call-active` / `call-ended`.
  - **`meetingDetectionEngine`** auto-starts via the *same* note-create path as the notification "Start" button (extracted to `_beginMeetingSession`), and broadcasts `meeting-auto-stop-request` on call end (only stops auto-started sessions).
- Scoped by a Fable plan; native helper compiles clean; tsc + renderer build + boot all pass. **Not yet verified on a real call.**

---

## Facts established (answers to questions asked)

- **Voice signatures across calls: YES.** `database.js:upsertSpeakerProfile(name, email, embeddingBuffer, profileId)` stores a named voice's embedding; `liveSpeakerIdentifier.js` matches future audio by cosine ≥ 0.65 (`MATCH_THRESHOLD`). Fully local (SQLite). Name a voice once → recognized next time.
- **Meeting auto-detection:** background tray app; watches Zoom/Teams/Webex/FaceTime *desktop apps* (process detection, `meetingProcessDetector.js`) + mic **device-in-use** (`macos-mic-listener.swift` — it's device-in-use, not energy) + Google Calendar. **Google Meet is browser-based → invisible to process detection**; audio/device signal is the only automatic path (hence PR #5). Detection **prompts**, never silently records (pre-PR#5).
- **"Sustained" audio timing:** ~2s (event-driven) to ~6s (polling) of mic device-in-use; single voice is enough (no multi-voice requirement); 5-min cooldown, 60s inactivity reset.
- **App stays resident** while open (tray app; closing windows hides, doesn't quit) but does **not** launch at login unless enabled (`openAtLogin` toggle).
- **MCP server is REMOTE/hosted**, not local — a public URL on OpenWhispr's cloud tied to `OPENWHISPR_API_URL` (empty in the fork → non-functional). No MCP SDK/server code in the app. It's an account/cloud feature.
- **Google Calendar** talks directly to Google (accounts.google.com / googleapis.com) via PKCE + loopback — tokens/data never route through OpenWhispr. Only a cosmetic, dataless post-OAuth browser redirect touches openwhispr.com (overridable via `VITE_OPENWHISPR_OAUTH_CALLBACK_URL`). **Won't work in the fork** without your own `GOOGLE_CALENDAR_CLIENT_ID`/`SECRET` in `.env`.
- **Dictation/typing** into other apps needs macOS **Accessibility** permission (auto-paste). Not required for meeting transcription-only use.
- **FluidVoice overlap:** OpenWhispr's dictation replaces FluidVoice's; don't run both as active dictation tools (hotkey/typing conflicts).
- **Post-call diarization time:** FluidAudio (ANE) ~15–30s for a 60-min meeting; sherpa-onnx (CPU) ~2–5min.

---

## Open items / follow-ups (see HANDOFF.md for the actionable list)

1. **Version bump to 1.9.0** for the auto-start feature (PR #5) — not yet done.
2. **MCP integration card removal** — offered, never confirmed by the user.
3. **Real-call test of auto-start** (PR #5) — needs a live Meet/Zoom call on the user's Mac.
4. **Diarization accuracy** not validated on real multi-party audio (synthetic `say` voices are a poor proxy).
5. **Full `.dmg` build** (`npm run build:mac:arm64`) not run end-to-end.
6. **Call-detector app attribution** — v1 can't read which app holds the camera/mic (CoreMediaIO doesn't expose the PID); the URL filter compensates. Log-stream parsing (OverSight technique) could add attribution later.
7. **Google Calendar** self-hosting: needs own Google OAuth creds + optional local callback page.
