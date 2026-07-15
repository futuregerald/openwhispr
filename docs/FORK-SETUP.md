# OpenWhispr (FluidAudio fork) — Setup & Sharing Guide

A local, private meeting transcriber with **real N-speaker diarization** — a Krisp/Granola
alternative that runs entirely on your machine. This fork adds an optional, faster/more-accurate
diarization engine (**FluidAudio**, on the Apple Neural Engine) on top of upstream OpenWhispr.

Diarization here is a **post-call pass**: transcription happens live during the meeting, and
speaker labels are computed right after it ends (seconds for a typical meeting).

## Quick start (macOS, Apple Silicon)

Prerequisites:
- **Node.js ≥ 24** (`node -v`)
- **Xcode Command Line Tools** (for the FluidAudio build): `xcode-select --install`

```bash
git clone https://github.com/futuregerald/openwhispr.git
cd openwhispr
npm install
npm run setup:fluidaudio     # builds the FluidAudio CLI into resources/bin (optional but recommended)
npm run dev                  # first run downloads whisper/sherpa/model binaries, then launches
```

That's it. In the app: **Settings → Speech to Text → enable Local Whisper**, then start a meeting.
Speaker diarization runs automatically after the meeting; you can rename/lock speakers in the
transcript, and named speakers persist across meetings.

If you skip `npm run setup:fluidaudio` (or you're not on a Mac), the app still works — it falls
back to the cross-platform **sherpa-onnx** diarization engine automatically.

## Choosing / forcing the diarization engine

FluidAudio is auto-selected on macOS when installed. To override:

```bash
OPENWHISPR_DIARIZATION_ENGINE=sherpa npm run dev      # force the cross-platform engine
OPENWHISPR_DIARIZATION_ENGINE=fluidaudio npm run dev  # force FluidAudio (macOS)
```

See `docs/FLUIDAUDIO-INTEGRATION.md` for all options.

## Sharing with coworkers

**Option A — they run from source (simplest, fully transparent).**
Send them this repo URL; they follow the Quick start above. Everything is local; no accounts.

**Option B — build a `.dmg` to hand them.**
```bash
npm run setup:fluidaudio     # ensure the FluidAudio binary is in resources/bin first
npm run build:mac            # produces a .dmg under dist/
```
Because this build isn't notarized with an Apple Developer ID, macOS Gatekeeper will block it on
their machine until they clear the quarantine flag once:
```bash
xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"
```
For friction-free distribution you'd need an Apple Developer ID and notarization (out of scope
for this fork). Option A avoids all of that.

## Staying in sync with upstream OpenWhispr

This fork keeps changes isolated (two files + additive script/docs), so upstream updates merge
cleanly:

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git   # one-time
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
```

## What's in this fork vs upstream

| | Upstream OpenWhispr | This fork |
|---|---|---|
| Local transcription (whisper.cpp) | ✅ | ✅ |
| N-speaker diarization (sherpa-onnx) | ✅ | ✅ |
| FluidAudio (ANE) diarization backend | — | ✅ optional, auto-selected on macOS |
| Editable/persistent speaker profiles | ✅ | ✅ |

Full technical detail: `docs/FLUIDAUDIO-INTEGRATION.md`. Research/rationale:
`docs/LOCAL-DIARIZATION-RESEARCH.md`.
