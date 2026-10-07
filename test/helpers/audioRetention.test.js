const test = require("node:test");
const assert = require("node:assert");

const { planAudioCleanup, parseMeetingNoteId } = require("../../src/helpers/audioRetention");

const DAY = 86400000;
const NOW = 1_700_000_000_000;
const CUTOFF = NOW - 30 * DAY;

const old = (name) => ({ name, mtimeMs: CUTOFF - DAY });
const fresh = (name) => ({ name, mtimeMs: NOW - DAY });

test("parseMeetingNoteId reads the note id from a meeting track", () => {
  assert.equal(parseMeetingNoteId("OpenWhispr-meeting-42-20260812-mic.opus"), 42);
  assert.equal(parseMeetingNoteId("OpenWhispr-meeting-7-stamp-system.opus"), 7);
  assert.equal(parseMeetingNoteId("OpenWhispr-2026-08-12-14-01-02-99.webm"), null);
  assert.equal(parseMeetingNoteId("nonsense.opus"), null);
});

test("expired audio for a processed meeting is deleted, as before", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-1-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => false,
  });
  assert.deepEqual(plan.deleteFiles, ["OpenWhispr-meeting-1-x-mic.opus"]);
  assert.deepEqual([...plan.expiredNoteIds], [1]);
  assert.equal(plan.retainedNoteIds.size, 0);
});

test("expired audio for an UNPROCESSED meeting is retained", () => {
  // The whole point of deferring a meeting is that it can still be processed
  // later. Deleting its audio on a timer makes the deferral a silent data loss.
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-9-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: (id) => id === 9,
  });
  assert.deepEqual(plan.deleteFiles, []);
  assert.equal(plan.expiredNoteIds.size, 0);
  assert.deepEqual([...plan.retainedNoteIds], [9]);
});

test("both tracks of an unprocessed meeting are retained together", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-9-x-mic.opus"), old("OpenWhispr-meeting-9-x-system.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: (id) => id === 9,
  });
  assert.deepEqual(plan.deleteFiles, []);
  // Retaining one track and deleting the other would leave a half-processable meeting.
  assert.deepEqual([...plan.retainedNoteIds], [9]);
});

test("fresh audio is kept regardless of processing state", () => {
  const plan = planAudioCleanup({
    files: [fresh("OpenWhispr-meeting-3-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => true,
  });
  assert.deepEqual(plan.deleteFiles, []);
  assert.equal(plan.keptCount, 1);
});

test("dictation audio is unaffected by the meeting guard", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-2026-08-12-14-01-02-99.webm")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => true,
  });
  assert.deepEqual(plan.deleteFiles, ["OpenWhispr-2026-08-12-14-01-02-99.webm"]);
  assert.deepEqual(plan.expiredTranscriptionIds, ["99"]);
});

test("legacy dictation filenames still yield their id", () => {
  const plan = planAudioCleanup({
    files: [old("123.webm")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => false,
  });
  assert.deepEqual(plan.expiredTranscriptionIds, ["123"]);
});

test("a failing processed-check retains rather than deletes", () => {
  // If we cannot tell whether a meeting was processed, the safe answer is to
  // keep the audio. Deleting is irreversible; keeping costs disk.
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-5-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => {
      throw new Error("db unavailable");
    },
  });
  assert.deepEqual(plan.deleteFiles, []);
  assert.deepEqual([...plan.retainedNoteIds], [5]);
});

test("a mixed sweep deletes only what it should", () => {
  const plan = planAudioCleanup({
    files: [
      old("OpenWhispr-meeting-1-x-mic.opus"), // processed -> delete
      old("OpenWhispr-meeting-2-x-mic.opus"), // unprocessed -> keep
      old("OpenWhispr-2026-01-01-00-00-00-50.webm"), // dictation -> delete
      fresh("OpenWhispr-meeting-3-x-mic.opus"), // fresh -> keep
    ],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: (id) => id === 2,
  });
  assert.deepEqual(plan.deleteFiles.sort(), [
    "OpenWhispr-2026-01-01-00-00-00-50.webm",
    "OpenWhispr-meeting-1-x-mic.opus",
  ]);
  assert.deepEqual([...plan.retainedNoteIds], [2]);
  assert.deepEqual([...plan.expiredNoteIds], [1]);
  assert.deepEqual(plan.expiredTranscriptionIds, ["50"]);
});

// A split child's note id never appears in any audio filename — the file is
// named after the note that recorded it — so a sweep that derives the owner from
// the filename alone asks the wrong note whether the meeting was processed, and
// clears the columns on the wrong note afterwards.
test("a shared file is retained when ANY note referencing it is unprocessed", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-1-x-system.opus")],
    cutoffMs: CUTOFF,
    // Note 1 has its notes; note 2 is the split child whose notes failed.
    isMeetingUnprocessed: (id) => id === 2,
    notesSharingFile: () => [1, 2],
  });

  assert.deepEqual(plan.deleteFiles, [], "this file is the only copy of note 2's meeting");
  assert.equal(plan.expiredNoteIds.size, 0);
  assert.deepEqual([...plan.retainedNoteIds].sort(), [1, 2]);
});

test("deleting a shared file reports every note referencing it, not just the filename's", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-1-x-system.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => false,
    notesSharingFile: () => [1, 2],
  });

  assert.deepEqual(plan.deleteFiles, ["OpenWhispr-meeting-1-x-system.opus"]);
  assert.deepEqual(
    [...plan.expiredNoteIds].sort(),
    [1, 2],
    "a sibling left pointing at a deleted file still hands the player a URL that fails"
  );
});

test("a note sharing a file is counted even when the filename names no note", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-4-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: (id) => id === 9,
    notesSharingFile: () => [9],
  });

  assert.deepEqual(plan.deleteFiles, []);
  assert.deepEqual([...plan.retainedNoteIds].sort(), [4, 9]);
});

test("a failing sharing lookup retains rather than deletes", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-6-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => false,
    notesSharingFile: () => {
      throw new Error("db unavailable");
    },
  });

  assert.deepEqual(plan.deleteFiles, []);
  assert.deepEqual([...plan.retainedNoteIds], [6]);
});

test("with no sharing lookup the sweep behaves exactly as it did before", () => {
  const plan = planAudioCleanup({
    files: [old("OpenWhispr-meeting-1-x-mic.opus")],
    cutoffMs: CUTOFF,
    isMeetingUnprocessed: () => false,
  });

  assert.deepEqual(plan.deleteFiles, ["OpenWhispr-meeting-1-x-mic.opus"]);
  assert.deepEqual([...plan.expiredNoteIds], [1]);
});
