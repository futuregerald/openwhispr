# Roadmap: call ending, cut, switch, combine

Brief and decisions (D1–D4): `docs/plans/2026-11-10-call-ending-brief.md` (local). Chosen UI: Teenage Engineering
recorder deck (`design-demos/direction-approved.md`, local).

## Status

| Phase | Scope | Status | Plan |
|---|---|---|---|
| 1 | Recordings stop on their own: 2-hour cap with a warning, call-end stop when a call was seen | not started | 2026-11-10-call-ending-phase1-auto-stop |
| 2 | Recorder deck, NEXT (switch) and SPLIT at any line | not started | — |
| 3 | JOIN (combine) and Separate again | not started | — |

## Strategy

- **Phase 1 first** because runaway recordings are the urgent harm. A recording can run for days and produce
  notes from silence (one note reached ~117 h), and the fix doesn't depend on the other two phases. It also fixes
  two bugs the trace found in the stop path: dictation cancels a meeting's safety limit, and an automatic stop is
  lost when the notes screen isn't open.
- **Phase 2 second** because NEXT and SPLIT share one new piece: cutting a note at a chosen moment. NEXT records
  the moment during a recording (D2), and SPLIT lets you pick it afterwards. Both feed the same cut, so building
  them together tests that piece twice. The deck UI arrives here, since NEXT lives on it.
- **Phase 3 last** because JOIN is the undo for SPLIT and NEXT. It needs the hide-not-delete storage for originals
  (D3) and audio joining, the largest database change in the set. Until it ships, the split dialog keeps saying a
  split can't be undone.

## Phases

### Phase 1: recordings stop on their own
- Every meeting recording, however it started, shows an always-on-top card at 1 h 55 m: "Recording ends in 5
  minutes", with Keep recording (+2 h) and Stop now. Ignored, the recording stops at 2 h 00 m.
- On macOS, a meeting recording in which the app saw a call (camera in use, or a matched meeting tab) stops about
  24 s after that call ends. A recording with no call seen never stops this way (D1). "Call ended — recording
  stopped" then shows with Resume for 10 s. Resume starts a new note titled "<title> (continued)" (JOIN in Phase 3
  puts them together), so the first part keeps its audio.
- Starting or stopping a dictation during a meeting recording no longer changes either rule.
- The cap and call-end stops work whichever screen of the app is open.
- Acceptance: engine tests with mocked timers prove each point, including a dictation started and stopped mid-way,
  a denied browser check counting as "no signal", and the stop reaching the recording store with the notes screen
  closed.

### Phase 2: recorder deck, NEXT and SPLIT
- While recording a meeting, a deck under the note shows REC, elapsed time, NEXT and STOP. NEXT marks the moment,
  and the deck lists tracks 01, 02, … live.
- When the recording stops, each marked track becomes its own note with its own title and notes, and the speaker
  names stay consistent across them (D2).
- On a finished note, choosing any transcript line and pressing SPLIT cuts the note there, after a preview with
  editable names. The detected gap is suggested.
- On notes whose timing can't be split reliably, SPLIT is disabled with a reason (D4).
- Acceptance: on a real-shaped fixture, cutting at a chosen line gives two notes whose lines, audio slices and
  speakers partition the original, with nothing lost or duplicated. A recording with two NEXT markers becomes three
  notes after the post-call pipeline.

### Phase 3: JOIN and Separate again
- Pick two or more notes and press JOIN: one combined note in time order, with the gap between calls shown, a
  joined recording, and regenerated notes.
- The originals are hidden, not deleted, and Separate again restores them exactly (D3).
- The split dialog stops saying a split can't be undone.
- Acceptance: join then separate restores both originals byte-for-byte in transcript, speakers, audio paths and
  hand-edited notes.

## Stop rules

- If the call-end check stops a real meeting during Phase 1's own manual testing, stop and re-plan D1 before Phase 2.
- If cutting at a chosen line can't partition real-shaped notes without losing or duplicating a line, stop:
  Phases 2 and 3 both rest on it.
- If joining recordings can't keep the timing correct for playback and re-transcription, re-plan the audio side of
  D3 before building Separate again.

## Agreement record

- 2026-11-10: decisions D1–D4 agreed on the decision page (all recommended options).
- 2026-11-10 — user, asked to agree to the three-phase order (auto-stop, then deck + NEXT + SPLIT, then JOIN) and to
  Resume starting a new "(continued)" note: "yes. use subagent driven development with sonnet 5.5 as the implementor".
